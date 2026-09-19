/**
 * P6 不变量断言集 —— INV-1 ~ INV-10
 *
 * 【硬约束 8】每条不变量一个**具名函数**，且被每轮动作后无条件调用。
 *
 * 断言设计的三个关键决策：
 *
 * 1. **读不到的状态不跳过，而是改成「此时应有的行为」**
 *    例：`getCounts()` 在未封存时被设计为 revert（硬约束 3 分步公示）。
 *    若 INV-1 写成「if (finalized) 才检查」，那么未封存期间它就是个空操作，
 *    「每轮无条件调用」就失去了意义。改为：未封存时断言「它必须 revert」——
 *    这样同一条断言在所有状态下都有实质内容，且顺带守护了硬约束 3。
 *
 * 2. **同时比对链上与链下**
 *    多条不变量（INV-1/3/4/8）无法仅凭链上查询验证，因为合约刻意不暴露
 *    「nullifier → 承诺」的映射（那会泄露关联，见 P5 匿名设计）。
 *    因此断言把「链上计数」与「链下追踪记录」对照——两者不一致即说明
 *    要么合约有缺陷，要么追踪逻辑有误，两种情况都必须查清。
 *
 * 3. **增量检查**（见 world.ts 的 `checks` 说明）
 *    追踪列表全是 append-only，已检查的前缀不会再变，故只检查新增部分。
 *    这不削弱强度（每个元素仍被恰好检查一次），但把复杂度从
 *    O(动作数 × 票据数) 降到 O(动作数 + 票据数)。
 *    游标一律在**断言通过之后**才推进，失败时保持原值便于定位。
 */

import { expect } from "chai";
import type { Invariant } from "./engine";
import { type World, popcount } from "./world";

/** 读取各选项得票（仅封存后可读） */
export async function readCounts(w: World): Promise<bigint[]> {
    // ethers v6 返回的 Result 是只读 Proxy，必须先浅拷贝再转换（P0 实测教训）
    const raw = await w.proposal.getCounts();
    return Array.from(raw).map((x: any) => BigInt(x));
}

/** 当前区块时间 */
async function now(): Promise<bigint> {
    const { time } = await import("@nomicfoundation/hardhat-network-helpers");
    return BigInt(await time.latest());
}

/** 断言某次调用必定 revert */
async function expectRevert(fn: () => Promise<unknown>, msg: string): Promise<void> {
    let ok = false;
    try {
        await fn();
        ok = true;
    } catch {
        // 预期路径
    }
    if (ok) throw new Error(msg);
}

// ============================================================
// INV-1 票数守恒
// ============================================================

/**
 * INV-1 —— 票数守恒。
 *
 * 两段断言，覆盖全部状态：
 * · `totalMarks` 必须恒等于「链下已接受票据的 popcount 之和」（揭示期即可检）
 * · 未封存时 `getCounts()` 必须 revert；已封存时 `sum(counts) === totalMarks`
 *
 * @param w 世界状态
 */
export async function checkTicketConservation(w: World): Promise<void> {
    // 增量累加：只处理新接受的票据
    let pendingSum = 0n;
    for (let i = w.checks.marksUpto; i < w.acceptedBallots.length; i++) {
        pendingSum += BigInt(popcount(w.acceptedBallots[i].mask));
    }
    const expected = w.checks.marksSum + pendingSum;

    const totalMarks = BigInt(await w.proposal.totalMarks());
    expect(totalMarks, "INV-1: totalMarks 应等于链下已接受票据 popcount 之和").to.equal(expected);

    // 通过后才推进游标
    w.checks.marksUpto = w.acceptedBallots.length;
    w.checks.marksSum = expected;

    const finalized = await w.proposal.finalized();

    if (!finalized) {
        // 硬约束 3：分步公示 —— 未封存时结果不可读
        await expectRevert(
            () => w.proposal.getCounts(),
            "INV-1/硬约束3: 未封存时 getCounts() 必须 revert，否则违反分步公示"
        );
        return;
    }

    const counts = await readCounts(w);
    const sum = counts.reduce((a, b) => a + b, 0n);
    expect(sum, "INV-1: sum(counts) 应等于 totalMarks").to.equal(totalMarks);
}

// ============================================================
// INV-2 揭示不超额
// ============================================================

/**
 * INV-2 —— 揭示数不超过参与人数。
 * @param w 世界状态
 */
export async function checkRevealNotExceeding(w: World): Promise<void> {
    const nullifierCount = BigInt(await w.proposal.nullifierCount());
    const revealedCount = BigInt(await w.proposal.revealedCount());

    expect(revealedCount, "INV-2: revealedCount 不得超过 nullifierCount").to.be.lessThanOrEqual(
        nullifierCount
    );
    expect(nullifierCount, "INV-2: nullifierCount 应等于链下已上链票据数").to.equal(
        BigInt(w.castedBallots.length)
    );
    expect(revealedCount, "INV-2: revealedCount 应等于链下已接受票据数").to.equal(
        BigInt(w.acceptedBallots.length)
    );
}

// ============================================================
// INV-3 一人一票
// ============================================================

/**
 * INV-3 —— 每个 nullifier 至多对应一个已接受承诺。
 *
 * 三段：
 * · 链下（内存）：已接受票据的 nullifier 互不相同
 * · 链上（增量）：所有成功提交过的 nullifier 必须被标记为已使用
 * · 链上（O(1)）：nullifierCount 等于去重后的 nullifier 数（防重复计数）
 *
 * @param w 世界状态
 */
export async function checkOnePersonOneVote(w: World): Promise<void> {
    const acceptedNullifiers = w.acceptedBallots.map((b) => b.nullifier.toString());
    expect(
        new Set(acceptedNullifiers).size,
        "INV-3: 同一 nullifier 不得对应多个已接受承诺"
    ).to.equal(acceptedNullifiers.length);

    for (let i = w.checks.castedNullifier; i < w.castedBallots.length; i++) {
        const b = w.castedBallots[i];
        const used: boolean = await w.proposal.isNullifierUsed(b.nullifier);
        expect(
            used,
            `INV-3: 成功提交过的 nullifier ${b.nullifier} 必须被标记为已使用`
        ).to.equal(true);
    }
    w.checks.castedNullifier = w.castedBallots.length;

    const castedNullifiers = new Set(w.castedBallots.map((b) => b.nullifier.toString()));
    const nullifierCount = BigInt(await w.proposal.nullifierCount());
    expect(nullifierCount, "INV-3: nullifierCount 应等于去重后的已提交 nullifier 数").to.equal(
        BigInt(castedNullifiers.size)
    );
}

// ============================================================
// INV-4 选项合法
// ============================================================

/**
 * INV-4 —— 任一被接受的选票必须位宽合法且不超选择上限；
 * 且作废计数与链下记录一致。
 * @param w 世界状态
 */
export async function checkBallotValidity(w: World): Promise<void> {
    const fullMask = 1 << w.optionCount;

    for (let i = w.checks.acceptedValidity; i < w.acceptedBallots.length; i++) {
        const b = w.acceptedBallots[i];
        expect(b.mask, "INV-4: 被接受的位图不得含越界位").to.be.lessThan(fullMask);
        expect(
            popcount(b.mask),
            `INV-4: 被接受的位图 ${b.mask.toString(2)} 选中数不得超过 maxChoices`
        ).to.be.lessThanOrEqual(w.maxChoices);
    }
    w.checks.acceptedValidity = w.acceptedBallots.length;

    const rejectedCount = BigInt(await w.proposal.rejectedCount());
    expect(rejectedCount, "INV-4: rejectedCount 应等于链下记录的作废承诺数").to.equal(
        BigInt(w.rejectedCommitments.length)
    );
}

// ============================================================
// INV-5 阶段单调
// ============================================================

/**
 * INV-5 —— `phase()` 只能前进，永不回退。
 *
 * 本断言**有副作用**（更新 `w.maxPhase`），这是刻意的：
 * 单调性无法从单次快照验证，必须记录历史最大值。
 * @param w 世界状态
 */
export async function checkPhaseMonotonic(w: World): Promise<void> {
    const p = Number(await w.proposal.phase());
    expect(p, `INV-5: 阶段从 ${w.maxPhase} 回退到 ${p}`).to.be.greaterThanOrEqual(w.maxPhase);
    if (p > w.maxPhase) w.maxPhase = p;
}

// ============================================================
// INV-6 封存不可逆
// ============================================================

/**
 * INV-6 —— 封存至多一次，且封存后结果恒定。
 * @param w 世界状态
 */
export async function checkFinalizeIrreversible(w: World): Promise<void> {
    expect(w.finalizeOkCount, "INV-6: finalize 成功次数不得超过 1").to.be.lessThanOrEqual(1);

    const finalized: boolean = await w.proposal.finalized();
    if (!finalized) return;
    if (w.countsAfterFinalize === null) return;

    const counts = await readCounts(w);
    expect(counts, "INV-6: 封存后 counts 不得改变").to.deep.equal(w.countsAfterFinalize);

    const resultHash: string = await w.proposal.resultHash();
    expect(resultHash, "INV-6: 封存后 resultHash 不得改变").to.equal(w.resultHashAfterFinalize);
}

// ============================================================
// INV-7 名册冻结
// ============================================================

/**
 * INV-7 —— 名册根一旦冻结即不可变；登记期结束后根不再变化。
 * @param w 世界状态
 */
export async function checkRosterFrozen(w: World): Promise<void> {
    const t = await now();

    // 登记期结束后，当前根必须冻结不变（这是 F-01 的核心承诺）
    if (t >= w.times.registrationEnd) {
        const currentRoot = BigInt(await w.registry.currentRoot());
        if (w.rootAfterRegistrationEnd === null) {
            w.rootAfterRegistrationEnd = currentRoot;
        } else {
            expect(
                currentRoot,
                "INV-7: 登记期结束后 currentRoot 不得变化（F-01 回归点）"
            ).to.equal(w.rootAfterRegistrationEnd);
        }
    }

    const frozen: boolean = await w.registry.frozen();
    if (!frozen) {
        expect(w.frozenRootSnapshot, "INV-7: 链下不应记录冻结根，但链上显示已冻结").to.equal(null);
        return;
    }

    const frozenRoot = BigInt(await w.registry.frozenRoot());
    if (w.frozenRootSnapshot === null) {
        w.frozenRootSnapshot = frozenRoot;
    } else {
        expect(frozenRoot, "INV-7: frozenRoot 一旦设定不得改变").to.equal(w.frozenRootSnapshot);
    }
}

// ============================================================
// INV-8 提交有效性（F-02）
// ============================================================

/**
 * INV-8 —— 任一被接受的揭示，其承诺必然曾在投票期上链（F-02 关键防护）。
 *
 * 这条不变量直接对应「凭空造票」漏洞：若揭示不校验票据存在性，
 * 任何人都能自造 `Poseidon(mask, salt)` 并无限造票。
 * @param w 世界状态
 */
export async function checkCommitmentWasCast(w: World): Promise<void> {
    for (let i = w.checks.acceptedCast; i < w.acceptedBallots.length; i++) {
        const b = w.acceptedBallots[i];
        const cast: boolean = await w.proposal.isCommitmentCast(b.commitment);
        expect(
            cast,
            `INV-8: 被接受的承诺 ${b.commitment} 必须曾在投票期上链（否则即凭空造票）`
        ).to.equal(true);
    }
    w.checks.acceptedCast = w.acceptedBallots.length;

    for (let i = w.checks.castedCast; i < w.castedBallots.length; i++) {
        const b = w.castedBallots[i];
        const cast: boolean = await w.proposal.isCommitmentCast(b.commitment);
        expect(cast, `INV-8: 已上链的承诺 ${b.commitment} 在链上应显示为已提交`).to.equal(true);
    }
    w.checks.castedCast = w.castedBallots.length;
}

// ============================================================
// INV-9 写入滞后（F-05）
// ============================================================

/**
 * INV-9 —— `_nullifierUsed` 的写入必然发生在 ZK 验证通过之后（F-05）。
 *
 * 防护的是：若先写状态再验证，攻击者可用伪造 nullifier 批量写脏状态，
 * 并可用他人的 nullifier 使其永久无法投票（DoS）。
 *
 * 检法：对每一次「提交了但验证失败」的尝试，其 nullifier 在链上必须仍未使用。
 * @param w 世界状态
 */
export async function checkWriteHappensAfterVerification(w: World): Promise<void> {
    const successful = new Set(w.castedBallots.map((b) => b.nullifier.toString()));

    for (let i = w.checks.failedNullifier; i < w.failedNullifiers.length; i++) {
        const n = w.failedNullifiers[i];
        // 该 nullifier 后来成功提交过，则被标记是合法的
        if (successful.has(n.toString())) continue;

        const used: boolean = await w.proposal.isNullifierUsed(n);
        expect(
            used,
            `INV-9: nullifier ${n} 的提交未通过验证，却被标记为已使用 —— ` +
                `写入发生在验证之前（F-05）`
        ).to.equal(false);
    }
    w.checks.failedNullifier = w.failedNullifiers.length;
}

// ============================================================
// INV-10 投票路径不记录发送者（P5 新增）
// ============================================================

const NO_ADDRESS_EVENTS = [
    "BallotCommitted",
    "BallotRevealed",
    "RevealRejected",
    "ProposalFinalized",
];

/**
 * ABI 是编译期固定的，检查一次即可。用模块级标志避免每次动作都重新解析 fragment
 * （32768 次动作下，这个"小优化"省掉的是 13 万次 ABI 解析）。
 */
let senderEventCheckPassed = false;

/**
 * 重置 ABI 检查的缓存。主测试在每个战役开始前调用，
 * 确保「每条不变量每轮都被实际执行」这一自检在各测试间独立成立。
 */
export function resetSenderEventCheck(): void {
    senderEventCheckPassed = false;
}

/**
 * INV-10 —— 投票、揭示、封存路径产生的事件**不含任何 address 类型字段**。
 *
 * 为什么这条不变量存在：P5 实测证伪了 ERC-2771 方案（它把签名者地址写入 calldata）。
 * 修正后的纯中继模型下，合约仍可能在事件里「顺手」记录 `msg.sender`
 * ——那样索引器就会建立「中继 ↔ 票」的关联。本断言从 ABI 层面杜绝该可能。
 *
 * 注：这是**静态**断言（事件签名不变即恒成立）。交易层面的「calldata 不含地址」
 * 由 `test/p5.metatx.test.ts` 动态验证；两者互补。
 *
 * @param w 世界状态
 */
export async function checkNoSenderInEvents(w: World): Promise<void> {
    if (senderEventCheckPassed) return;

    const iface = w.proposal.interface;

    for (const evName of NO_ADDRESS_EVENTS) {
        const frag = iface.getEvent(evName);
        expect(frag, `INV-10: 未找到事件 ${evName}`).to.not.equal(null);

        const addrParams = frag!.inputs.filter((i: any) => i.type === "address");
        expect(
            addrParams.length,
            `INV-10: 事件 ${evName} 含 address 字段（${addrParams
                .map((i: any) => i.name)
                .join(", ")}）—— 会把发送者身份写入链上索引`
        ).to.equal(0);
    }

    senderEventCheckPassed = true;
}

// ============================================================
// INV-11 工厂创建计数与提案注册表一致（P7）
// ============================================================

/**
 * INV-11 —— `ProposalFactory` 的「创建计数」与「提案注册表」恒等。
 *
 * 具体断言：
 * · `proposalCount == proposalsLength()`
 *   （`_proposals.length` 是编号 → 地址索引数组，`proposalCount` 是最后分配的编号；
 *    二者在每次成功 `createProposal` 时同步 +1，必须恒等。）
 * · 边界一致性：`proposalOf(proposalCount) == proposalAt(proposalCount - 1)`
 *   （第 i 个下标对应编号 i+1；工厂是 append-only，只要最近一次创建把同一地址
 *    同时写入 `_proposalById[proposalCount]` 与 `_proposals`，整张表就一致。）
 *
 * 【为什么只查边界而非全表】
 *   随机战役每轮动作后都无条件调用本断言（硬约束 8）。若全表遍历，
 *   512×64 战役下复杂度会膨胀到 O(动作数 × 提案数)（千万级）；而工厂 append-only，
 *   边界一致即代表「上一次创建」合法，配合每轮调用可在**新增即发现**的时刻拦住回归，
 *   无需回放历史。这是性能与守护强度的平衡取舍，已注释说明。
 *
 * @param w 世界状态
 */
export async function checkFactoryIndexConsistent(w: World): Promise<void> {
    const count: bigint = await w.factory.proposalCount();
    const len: bigint = await w.factory.proposalsLength();

    expect(count, "INV-11: 创建计数必须与索引数组长度恒等").to.equal(len);

    if (count === 0n) return;
    const atEnd: string = await w.factory.proposalAt(count - 1n);
    const byIdEnd: string = await w.factory.proposalOf(count);
    expect(
        byIdEnd,
        "INV-11: 最近一次创建的提案，按编号与按下标取出必须一致"
    ).to.equal(atEnd);
}

// ============================================================
// 清单
// ============================================================

/**
 * 构造本次战役的不变量清单。
 *
 * 【自检】主测试会断言清单长度为 10 且 id 连续。
 * 没有这个自检的话，有人误删一条断言，测试仍会全绿——而覆盖已经悄悄缩水。
 *
 * @param w 世界状态
 * @returns 不变量清单
 */
export function buildInvariants(w: World): Invariant[] {
    return [
        { id: "INV-1", name: "票数守恒", check: () => checkTicketConservation(w) },
        { id: "INV-2", name: "揭示不超额", check: () => checkRevealNotExceeding(w) },
        { id: "INV-3", name: "一人一票", check: () => checkOnePersonOneVote(w) },
        { id: "INV-4", name: "选项合法", check: () => checkBallotValidity(w) },
        { id: "INV-5", name: "阶段单调", check: () => checkPhaseMonotonic(w) },
        { id: "INV-6", name: "封存不可逆", check: () => checkFinalizeIrreversible(w) },
        { id: "INV-7", name: "名册冻结", check: () => checkRosterFrozen(w) },
        { id: "INV-8", name: "提交有效性（F-02）", check: () => checkCommitmentWasCast(w) },
        { id: "INV-9", name: "写入滞后（F-05）", check: () => checkWriteHappensAfterVerification(w) },
        { id: "INV-10", name: "事件不含发送者（P5）", check: () => checkNoSenderInEvents(w) },
        { id: "INV-11", name: "工厂计数与注册表一致（P7）", check: () => checkFactoryIndexConsistent(w) },
    ];
}

/** 期望的不变量条数，供主测试自检 */
export const EXPECTED_INVARIANT_COUNT = 11;
