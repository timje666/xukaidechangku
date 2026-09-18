/**
 * P6 世界状态 —— 链下追踪 + 辅助构造
 *
 * 设计要点：`loadFixture` 会**缓存并复用 fixture 的返回值（同一对象引用）**，
 * 因此可变状态**绝不能**放在 fixture 返回值里，否则测试之间会互相污染。
 * 分工：
 *   · fixture  → 只放不可变的合约引用与常量
 *   · 本文件   → 构造**每测试独有**的可变追踪对象
 *
 * 为什么需要链下追踪：多条不变量无法仅凭链上查询验证。例如 INV-3（一人一票）
 * 需要知道「哪个 nullifier 对应哪个承诺」，而链上 `_nullifierUsed` 是 private 映射、
 * 且**刻意不提供 nullifier → 承诺的查询接口**（那会泄露关联，见 P5 的匿名设计）。
 * 因此断言必须比对「链上计数」与「链下记录」是否一致——这也是本引擎相对
 * 纯模糊测试的优势：它能同时掌握两侧的信息。
 */

import { ethers } from "hardhat";

/** 本机实测的 SNARK 标量域（与 Semaphore / LeanIMT 一致） */
export const SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** 一张被追踪的选票 */
export interface TrackedBallot {
    /** 选民假名 */
    nullifier: bigint;
    /** 选票承诺（bytes32 hex） */
    commitment: string;
    /** 选票位图 */
    mask: number;
    /** 承诺盐值 */
    salt: bigint;
}

/** 链上视图快照 —— 动作权重决策依据 */
export interface ChainView {
    /** 当前阶段编号（0 REGISTRATION … 5 FINALIZED） */
    phase: number;
    /** 当前区块时间 */
    timestamp: bigint;
    /** 名册根是否已冻结 */
    frozen: boolean;
    /** 结果是否已封存 */
    finalized: boolean;
    /** 名册人数 */
    rosterSize: bigint;
}

/** 随机战役的可变世界状态 */
export interface World {
    // ---------- 不可变引用 ----------
    registry: any;
    proposal: any;
    pt4: any;
    scope: bigint;
    optionCount: number;
    maxChoices: number;
    /** 一个**已登记**的 signer，用于验证「已登记地址直投必拒」（硬约束 10） */
    registeredSigner: any;
    /** 未登记的中继账户，用于合法的投票提交 */
    relayer: any;
    /** 完全无关的账户，用于越权尝试 */
    outsider: any;
    /** 登记员 */
    registrar: any;

    // ---------- 时间窗 ----------
    times: {
        registrationEnd: bigint;
        votingStart: bigint;
        votingEnd: bigint;
        revealEnd: bigint;
    };

    /** 最近一次刷新的链上视图（由 refreshView 更新） */
    view: ChainView;
    /** `registeredSigner` 是否已写入名册 */
    signerRegistered: boolean;
    /**
     * 重启一个提案生命周期（重新部署 registry + proposal 并切到新的时窗）。
     *
     * **为什么必须有它**：实测发现，没有重启机制时随机序列会在流程终结后
     * 于终态上无限空转——512×64 战役里 78% 的动作消耗在已 FINALIZED 的提案上
     * （重复 finalize / 重复 freeze / noop），有效覆盖约等于一个生命周期。
     * 「跑了 32768 次」与「覆盖了 32768 种状态」是两回事。
     *
     * 由主测试注入（它需要 ethers 的合约工厂）。
     */
    spawn: () => Promise<void>;
    /** 已执行的生命周期数，供主测试断言覆盖度 */
    lifecycleCount: number;
    /**
     * 累计覆盖量（**跨生命周期累加，不随重启清零**）。
     *
     * 为什么需要它：`resetTrackingForNewLifecycle` 会清空各追踪列表，
     * 而战役很可能恰好结束于一次重启之后——此时"当前列表长度"全是 0，
     * 报告会显示成"什么都没覆盖"。累计值才能反映真实的覆盖总量。
     */
    cumulative: {
        registered: number;
        casted: number;
        accepted: number;
        rejected: number;
    };

    // ---------- 链下追踪（可变） ----------
    /** 已登记的选民地址（链下镜像） */
    registeredAddresses: string[];
    /** 已登记的承诺（链下镜像，用于生成唯一的候选承诺） */
    registeredCommitments: bigint[];
    /** 冻结时的根快照（用于 INV-7） */
    frozenRootSnapshot: bigint | null;
    /** 登记期结束时刻之后的根快照（用于 INV-7 的「登记结束即不可变」部分） */
    rootAfterRegistrationEnd: bigint | null;
    /** 投票期成功上链的票据 */
    castedBallots: TrackedBallot[];
    /** 揭示被接受的票据 */
    acceptedBallots: TrackedBallot[];
    /** 揭示被作废的承诺 */
    rejectedCommitments: string[];
    /**
     * 曾尝试提交但**验证失败**的 nullifier（用于 INV-9）。
     * INV-9 断言：这些 nullifier 在链上必须仍为未使用状态
     * —— 即「写入严格晚于验证通过」。
     */
    failedNullifiers: bigint[];
    /** finalize 成功次数（用于 INV-6） */
    finalizeOkCount: number;
    /** 已见到的最大阶段编号（用于 INV-5） */
    maxPhase: number;
    /** 封存后的 counts 快照（用于 INV-6 的「封存后票数恒定」） */
    countsAfterFinalize: bigint[] | null;
    /** 封存后的 resultHash 快照 */
    resultHashAfterFinalize: string | null;

    // ---------- 计数器 ----------
    commitmentSeq: number;
    saltSeq: number;
    nullifierSeq: number;
    addressSeq: number;

    /**
     * 断言用增量游标。
     *
     * 为什么需要：本引擎在**每次动作后**都调用全部不变量（硬约束 8）。
     * 若每条断言都线性扫描全部票据并逐张做链上查询，复杂度是 O(动作数 × 票据数)
     * ——32768 次动作下会从「跑 1 分钟」恶化到「跑 1 小时」。
     *
     * 由于 `castedBallots` / `acceptedBallots` / `rejectedCommitments` /
     * `failedNullifiers` 全都是 **append-only**（只 push，从不修改既有元素），
     * 已检查过的前缀不会变化，故只需检查新增部分。
     * 这不削弱检查强度：所有元素仍会被恰好检查一次。
     */
    checks: {
        /** INV-1：已累加过的 acceptedBallots 索引 */
        marksUpto: number;
        /** INV-1：已累加的 popcount 总和（游标之前的部分） */
        marksSum: bigint;
        /** INV-3：已做过 `isNullifierUsed` 链上核对的 castedBallots 索引 */
        castedNullifier: number;
        /** INV-9：已做过 `isNullifierUsed` 链上核对的 failedNullifiers 索引 */
        failedNullifier: number;
        /** INV-4：已做过位图合法性核对的 acceptedBallots 索引 */
        acceptedValidity: number;
        /** INV-8：已做过 `isCommitmentCast` 核对的 acceptedBallots 索引 */
        acceptedCast: number;
        /** INV-8：已做过 `isCommitmentCast` 核对的 castedBallots 索引 */
        castedCast: number;
    };
}

/** 构造一个新的可变世界状态 */
export function createWorld(base: {
    registry: any;
    proposal: any;
    pt4: any;
    scope: bigint;
    optionCount: number;
    maxChoices: number;
    times: World["times"];
    registeredSigner: any;
    relayer: any;
    outsider: any;
    registrar: any;
    spawn: () => Promise<void>;
}): World {
    return {
        ...base,
        // 初始视图为占位值，必须在战役开始前调用 refreshView() 填充
        view: { phase: 0, timestamp: 0n, frozen: false, finalized: false, rosterSize: 0n },
        signerRegistered: false,
        lifecycleCount: 1,
        cumulative: { registered: 0, casted: 0, accepted: 0, rejected: 0 },
        registeredAddresses: [],
        registeredCommitments: [],
        frozenRootSnapshot: null,
        rootAfterRegistrationEnd: null,
        castedBallots: [],
        acceptedBallots: [],
        rejectedCommitments: [],
        failedNullifiers: [],
        finalizeOkCount: 0,
        maxPhase: 0,
        countsAfterFinalize: null,
        resultHashAfterFinalize: null,
        commitmentSeq: 0,
        saltSeq: 0,
        nullifierSeq: 0,
        addressSeq: 0,
        checks: freshChecks(),
    };
}

/** 全新的增量游标集合 */
function freshChecks(): World["checks"] {
    return {
        marksUpto: 0,
        marksSum: 0n,
        castedNullifier: 0,
        failedNullifier: 0,
        acceptedValidity: 0,
        acceptedCast: 0,
        castedCast: 0,
    };
}

/**
 * 为一个新生命周期重置全部追踪状态。
 *
 * 【关键】**`maxPhase` 必须重置为 0**：INV-5（阶段单调）比较的是当前 phase
 * 与历史最大值，新提案从 REGISTRATION(0) 开始，若不重置会被误判为「阶段回退」。
 * 同理所有 append-only 列表与各类游标都要清空，否则会与旧提案的数据混在一起。
 *
 * @param w 世界状态
 */
export function resetTrackingForNewLifecycle(w: World): void {
    // 先把本生命周期的量并入累计值，再清空当前列表
    w.cumulative.registered += w.registeredAddresses.length;
    w.cumulative.casted += w.castedBallots.length;
    w.cumulative.accepted += w.acceptedBallots.length;
    w.cumulative.rejected += w.rejectedCommitments.length;

    w.registeredAddresses = [];
    w.registeredCommitments = [];
    w.frozenRootSnapshot = null;
    w.rootAfterRegistrationEnd = null;
    w.castedBallots = [];
    w.acceptedBallots = [];
    w.rejectedCommitments = [];
    w.failedNullifiers = [];
    w.finalizeOkCount = 0;
    w.maxPhase = 0;
    w.countsAfterFinalize = null;
    w.resultHashAfterFinalize = null;
    w.signerRegistered = false;
    w.checks = freshChecks();
}

/**
 * 刷新链上视图快照。
 *
 * 由引擎在**每次选动作之前**调用，使同步的 `weight()` 能基于最新阶段/时间决策。
 * 返回值用于统计阶段分布（确认随机序列确实穿越了完整流程）。
 *
 * @param w 世界状态
 * @returns 当前阶段编号
 */
export async function refreshView(w: World): Promise<number> {
    const { time } = await import("@nomicfoundation/hardhat-network-helpers");

    w.view = {
        phase: Number(await w.proposal.phase()),
        timestamp: BigInt(await time.latest()),
        frozen: await w.registry.frozen(),
        finalized: await w.proposal.finalized(),
        rosterSize: BigInt(await w.registry.rosterSize()),
    };

    return w.view.phase;
}

/**
 * 生成一个确定性的伪地址（用于登记）。
 *
 * 为什么不用 `ethers.Wallet.createRandom()`：它依赖 `Math.random`，会破坏可复现性
 * ——同一个 seed 在不同运行里会登记不同地址，失败便无法复现。
 *
 * @param w 世界状态
 * @returns 校验和格式的地址
 */
export function nextAddress(w: World): string {
    const seq = w.addressSeq++;
    const h = ethers.id(`chainvote-inv-address-${seq}`);
    return ethers.getAddress("0x" + h.slice(26));
}

/**
 * 生成一个唯一的承诺值。
 *
 * 约束：必须落在 SNARK 标量域内（`LeanIMT._insert` 会校验），且非零、不重复。
 * 用 `keccak256(序号) % 域` 构造——足够唯一，且完全确定性
 * （确定性是本引擎的前提，见 engine.ts 对 mulberry32 的说明）。
 *
 * @param w 世界状态
 * @returns 承诺值（非零，在域内）
 */
export function nextCommitment(w: World): bigint {
    const seq = w.commitmentSeq++;
    const v = BigInt(ethers.id(`chainvote-inv-commitment-${seq}`)) % SNARK_SCALAR_FIELD;
    return v === 0n ? 1n : v;
}

/** 生成一个唯一的盐值 */
export function nextSalt(w: World): bigint {
    return BigInt(1_000_000 + w.saltSeq++);
}

/** 生成一个唯一的 nullifier */
export function nextNullifier(w: World): bigint {
    return BigInt(8_000_000 + w.nullifierSeq++);
}

/** 统计位图中置位的数量 */
export function popcount(mask: number): number {
    let c = 0;
    let x = mask;
    while (x !== 0) {
        c += x & 1;
        x >>= 1;
    }
    return c;
}

/** 把任意值补齐为 32 字节 hex */
export function toHex32(v: bigint | string): string {
    const hex = typeof v === "bigint" ? v.toString(16) : v.replace(/^0x/, "");
    return "0x" + hex.padStart(64, "0");
}

/**
 * 用链上 `PoseidonT4` 计算选票承诺。
 *
 * **必须用链上实现**：链下 JS 版 Poseidon 是否与合约版逐位一致无法保证，
 * 而 `_revealOne` 正是用链上 `PoseidonT4.hash([mask, salt, SCOPE])` 校验的。
 * 若用链下实现生成、链上校验，一旦不一致就会表现为「所有揭示都被判 CommitmentMismatch」。
 *
 * @param w 世界状态
 * @param mask 选票位图
 * @param salt 盐值
 * @returns 32 字节 hex 承诺
 */
export async function computeCommitment(w: World, mask: number, salt: bigint): Promise<string> {
    const h: bigint = await w.pt4.hash([BigInt(mask), salt, w.scope]);
    return toHex32(h);
}
