/**
 * 畸形 calldata 模糊测试 —— 补上「字节码层输入空间」这一缺口
 *
 * ## 为什么需要它
 *
 * P6 主引擎在 ethers 层构造调用，输入空间受 ABI 编码器约束（只能生成**合法**编码）。
 * 这正是 `forge invariant` / Echidna 相对自研引擎的优势：它们在 EVM 字节码层工作，
 * 能构造 ABI 之外的任意字节序列。
 *
 * ## 关键：这个缺口是可以补上的
 *
 * 无需字节码模糊器，只需**绕过 ABI 编码器**直接发原始 calldata：
 *
 * ```ts
 * await signer.sendTransaction({ to, data: rawHex, gasLimit });
 * ```
 *
 * `data` 是原始字节，ethers 不会对它做 ABI 编码。于是可以构造截断、追加、
 * 谎报长度、越界偏移等任意畸形输入——输入空间**不再受 ABI 约束**。
 *
 * 差距仍然存在但不是「无法覆盖」，而是「需要人工设计变异算子」：
 * 没有自动收缩与自动变异，覆盖面取决于变异算子的质量。见 MUTATORS 的设计意图表。
 *
 * ## 最有价值的变异：尾部追加（★）
 *
 * P5 的教训——ERC-2771 把签名者地址追加进 calldata，构成一条隐藏数据通道。
 * 对本项目而言，「calldata 尾部被追加数据后行为是否改变」是一个**安全性质**：
 *   · 若行为改变 ⇒ 合约在读取尾部数据 ⇒ 存在可被利用的隐藏通道
 *   · 若行为不变 ⇒ Solidity 的 ABI 解码器按长度前缀正确忽略尾部
 *
 * 故本文件把「追加后行为必须与合法调用**完全一致**」设为断言，
 * 而不只是「不报错」。
 *
 * 【INV-11】新增不变量：畸形 calldata 不得使状态进入不一致态
 *   —— 要么 revert（状态回滚），要么成功且既有不变量全部成立。
 */

import { ethers } from "hardhat";

/** 确定性随机源（与主引擎同一实现，保证可复现） */
export type Rng = () => number;

/** 变异器对调用结果的预期 */
export type Expectation =
    /** 必须被拒（revert） */
    | "mustRevert"
    /** 必须与未变异版本行为**完全一致**（含成功/失败与状态） */
    | "mustNotChangeBehavior"
    /** 结果不限，但成功后状态必须自洽（通用变异，可能命中合法值） */
    | "maySucceed";

export interface Mutator {
    /** 变异器名称（用于测试标题与失败信息） */
    name: string;
    /** 设计意图（写清「为什么要有这个变异」，避免后人误删） */
    intent: string;
    /** 适用的目标函数；`*` 表示全部 */
    appliesTo: string[];
    expectation: Expectation;
    /** 施加变异 */
    apply: (hex: string, rng: Rng) => string;
}

/** 生成 n 字节的确定性十六进制串（不含 0x） */
function randHex(rng: Rng, n: number): string {
    let s = "";
    for (let i = 0; i < n; i++) {
        s += Math.floor(rng() * 256)
            .toString(16)
            .padStart(2, "0");
    }
    return s;
}

/** 把十六进制串的某个字节替换为另一个值 */
function pokeByte(hex: string, byteIndex: number, value: number): string {
    const start = 2 + byteIndex * 2;
    if (start + 2 > hex.length) return hex;
    return hex.slice(0, start) + value.toString(16).padStart(2, "0") + hex.slice(start + 2);
}

/**
 * 变异算子集合。
 *
 * 每条都必须有明确的**设计意图**——「随机乱改」不构成意图，
 * 因为收到失败时无法判断是合约缺陷还是测试期望写错。
 */
export const MUTATORS: Mutator[] = [
    // ---------------- 截断类：不完整参数必须被拒 ----------------
    {
        name: "截断尾部 1 字节",
        intent: "ABI 解码需要完整字（32 字节对齐），少 1 字节应被拒",
        appliesTo: ["*"],
        expectation: "mustRevert",
        apply: (h) => h.slice(0, -2),
    },
    {
        name: "截断尾部 32 字节",
        intent: "缺一个完整参数，必须被拒",
        appliesTo: ["*"],
        expectation: "mustRevert",
        apply: (h) => h.slice(0, -64),
    },
    {
        name: "仅保留函数选择器",
        intent: "无参数调用带参函数，必须被拒",
        appliesTo: ["*"],
        expectation: "mustRevert",
        apply: (h) => h.slice(0, 10),
    },
    {
        name: "空 calldata",
        intent: "合约无 fallback/receive，空 calldata 必须被拒",
        appliesTo: ["*"],
        expectation: "mustRevert",
        apply: () => "0x",
    },

    // ---------------- 追加类：★ 隐藏通道检测 ----------------
    {
        name: "追加 20 字节全零",
        intent:
            "★ ERC-2771 正是把地址追加到 calldata 尾部。本断言验证：追加 20 字节零" +
            "（等价于「从零地址转发」）后行为必须与合法调用完全一致——" +
            "若不一致，说明存在读取尾部数据的隐藏通道（P5 教训的直接延伸）",
        appliesTo: ["*"],
        expectation: "mustNotChangeBehavior",
        apply: (h) => h + "00".repeat(20),
    },
    {
        name: "追加 20 字节随机",
        intent: "★ 同上的非零版本：尾部被塞入任意地址也不得改变行为",
        appliesTo: ["*"],
        expectation: "mustNotChangeBehavior",
        apply: (h, rng) => h + randHex(rng, 20),
    },
    {
        name: "追加 1 字节",
        intent: "非字对齐的尾部数据同样应被忽略（ABI 解码按长度前缀，不按总长）",
        appliesTo: ["*"],
        expectation: "mustNotChangeBehavior",
        apply: (h, rng) => h + randHex(rng, 1),
    },
    {
        name: "追加 128 字节",
        intent: "大量尾部数据不得改变行为；同时也是对解码器性能的边界探测",
        appliesTo: ["*"],
        expectation: "mustNotChangeBehavior",
        apply: (h, rng) => h + randHex(rng, 128),
    },

    // ---------------- 选择器类 ----------------
    {
        name: "篡改选择器",
        intent: "未知选择器必须被拒（且不应 fallback 到某个函数）",
        appliesTo: ["*"],
        expectation: "mustRevert",
        apply: (h) => pokeByte(h, 0, 0xff),
    },

    // ---------------- 通用变异 ----------------
    {
        name: "随机翻转 1 字节",
        intent: "通用变异：可能命中合法值（如位图位、盐值），也可能被拒。" +
            "两者都允许，但**成功后状态必须自洽**",
        appliesTo: ["*"],
        expectation: "maySucceed",
        apply: (h, rng) => {
            const byteCount = (h.length - 2) / 2;
            const idx = Math.floor(rng() * byteCount);
            return pokeByte(h, idx, Math.floor(rng() * 256));
        },
    },

    // ---------------- 动态数组结构类（仅 reveal） ----------------
    {
        name: "数组长度谎报为 0",
        intent: "声明空数组：必须被空批校验拒绝（BatchTooLarge），不得静默成功",
        appliesTo: ["reveal"],
        expectation: "mustRevert",
        apply: (h) => setWord(h, 1, 0n),
    },
    {
        name: "数组长度谎报为极大值",
        intent: "声明 2^64 个元素：必须被拒（否则会越界读或耗尽 gas）",
        appliesTo: ["reveal"],
        expectation: "mustRevert",
        apply: (h) => setWord(h, 1, (1n << 64n) - 1n),
    },
    {
        name: "数组偏移指向越界",
        intent: "offset 指向 calldata 之外：ABI 解码必须 revert，不得读到越界内存",
        appliesTo: ["reveal"],
        expectation: "mustRevert",
        apply: (h) => setWord(h, 0, 0xffffn),
    },
];

/**
 * 覆写 calldata 中第 `wordIndex` 个字（32 字节）。
 * 字 0 = 参数区第 1 个字（即 selector 之后的第一个 32 字节槽）。
 *
 * @param hex calldata（0x 前缀）
 * @param wordIndex 字下标（0 起，从 selector 之后算）
 * @param value 新值
 * @returns 修改后的 calldata
 */
function setWord(hex: string, wordIndex: number, value: bigint): string {
    const start = 10 + wordIndex * 64; // 10 = "0x" + selector(8)
    if (start + 64 > hex.length) return hex;
    const word = value.toString(16).padStart(64, "0");
    return hex.slice(0, start) + word + hex.slice(start + 64);
}

/** 一次调用的结果 */
export interface CallResult {
    ok: boolean;
    /** 失败时的简要原因（截断，仅用于诊断输出） */
    reason?: string;
    /** 状态快照（仅在成功时有意义） */
    state?: string;
}

/**
 * 发送原始 calldata 并返回结果。
 *
 * **关键**：走 `signer.sendTransaction({ to, data })`，`data` 是原始字节，
 * ethers 不对其做 ABI 编码——这正是绕过 ABI 编码器的手段。
 * 显式给 `gasLimit` 是为了让畸形输入真正上链执行（而非停在 estimateGas 阶段），
 * 从而区分「被 EVM 拒绝」与「被估算器拒绝」。
 *
 * @param signer 发送者
 * @param to 目标合约
 * @param data 原始 calldata
 * @returns 调用结果
 */
export async function rawCall(signer: any, to: string, data: string): Promise<CallResult> {
    try {
        await signer.sendTransaction({ to, data, gasLimit: 3_000_000n });
        return { ok: true };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, reason: msg.slice(0, 160) };
    }
}

/**
 * 读取一组用于比对的合约状态。
 *
 * 只取「不会因阶段而 revert」的字段（`getCounts` 未封存时会 revert，故排除），
 * 保证在任何阶段都能取到可比对的快照。
 *
 * @param proposal Proposal 实例
 * @returns 状态摘要字符串
 */
export async function snapshotState(proposal: any): Promise<string> {
    const parts = await Promise.all([
        proposal.nullifierCount(),
        proposal.revealedCount(),
        proposal.rejectedCount(),
        proposal.totalMarks(),
        proposal.finalized(),
    ]);
    return parts.map((x: any) => x.toString()).join("|");
}

/** 取 EVM 快照 */
export async function evmSnapshot(): Promise<string> {
    return (await ethers.provider.send("evm_snapshot", [])) as string;
}

/** 回滚到指定快照 */
export async function evmRevert(id: string): Promise<void> {
    await ethers.provider.send("evm_revert", [id]);
}
