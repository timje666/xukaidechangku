/**
 * P6 失败最小化器 —— 补上「无收缩（shrinking）」这一能力缺口
 *
 * ## 问题
 *
 * `forge invariant` 失败时会自动**最小化反例**（shrinking）：把触发失败的调用序列
 * 收缩到最短形式，让人一眼看出根因。自研引擎原本只能复现完整序列（512×64 时是
 * 32768 步）后人工定位。
 *
 * ## 为什么不能直接照搬 ddmin
 *
 * 经典 ddmin 假设「任意子集仍能触发失败」。但状态机动作**有前置依赖**：
 * 删掉 `freezeVotersRoot` 后，后续 `castVote` 会因为根未冻结而失败，bug 自然不再触发。
 * 所以不能任意删——只能删「删掉后失败仍能复现」的动作。
 *
 * ## 三个使最小化可行的前提（都已在本引擎中落实）
 *
 * **1. 每步使用独立派生的随机源**
 *    `engine.runInvariantCampaign` 用 `mulberry32(seed ^ 全局步号)` 为每个步单独派生 rng，
 *    而不是共享一条流。若共享，删除一个动作会让后续动作拿到错位的随机值——
 *    参数全变，失败不再复现，最小化彻底无法进行。
 *
 * **2. 序列可记录**
 *    引擎记录完整动作序列（`stats.actionSequence`）。
 *
 * **3. 链上与链下状态必须一起回滚**（★最易踩的坑）
 *    只回滚 EVM 是不够的：链下追踪里的 `nextNullifier()` / `nextCommitment()` 计数器
 *    会继续递增，重放产生的票据参数与首次运行不同，失败不复现，最小化会误判为
 *    「该动作可删」并越删越离谱。因此本模块要求调用方同时提供
 *    `snapshot`/`revert`（链）与 `captureWorld`/`applyWorld`（链下）。
 *
 * **4. 派生视图必须同步刷新**（★实测踩到）
 *    某些动作的行为取决于**派生视图**而非直接取决于链上状态。例如 `advanceTime`
 *    按 `w.view.phase` 决定推进策略（可动作阶段须小步前进以保留动作机会）。
 *    重放时若不刷新视图，该动作会读到陈旧的 phase 并采取**不同的推进策略**，
 *    于是整条时间线错位、失败无法复现。
 *    ⇒ 故 `replayAndCheck` 在每步执行前都调用 `refreshView`，与引擎保持一致。
 *    一般原则：**重放必须复现所有影响动作行为的输入，而不只是链上状态。**
 *
 * ## 算法：窗口内贪心删除
 *
 * ```
 * 1. 回到基础状态，重放 [0, failIndex - windowSize) 作为前缀（承载全部前置条件）
 * 2. 在窗口起点同时固定 EVM 快照与链下追踪快照
 * 3. 窗口 = [failIndex - windowSize, failIndex]
 * 4. 确认窗口起点能复现失败（否则如实报告，而非假装成功）
 * 5. 贪心：逐个尝试删除窗口内动作；删除后仍能复现则保留删除
 * 6. 迭代 maxPasses 轮
 * ```
 *
 * **为什么限定在窗口内**：全序列最小化是 O(N²) 次动作执行，32768 步下不可行。
 * 破坏通常由紧邻的若干动作组合造成，窗口（默认 32）内的最小化已能把
 * 「回看 32768 步」降到「回看个位数步」——这正是收缩能力的实际用途。
 *
 * ## 成本（实测量级）
 *
 * 窗口 32、上限 2 轮 ⇒ 最多 64 次尝试 × ≤32 个动作 ≈ 2000 步执行 ≈ **约 35 秒**。
 * 这是失败时才付的一次性调试成本。
 */

import { type Action, type Invariant, mulberry32, type Rng } from "./engine";

export interface MinimizeConfig {
    /** 战役种子（决定每步的随机参数） */
    seed: number;
    /** 动作集（按名称索引） */
    actions: Action[];
    /** 不变量清单（用于判断「是否仍能复现失败」） */
    invariants: Invariant[];
    /** 失败时的完整动作序列（含失败步），来自 `stats.actionSequence` */
    sequence: string[];
    /** 失败步的全局序号（来自 `stats.failures[i].globalStep`） */
    failIndex: number;
    /** 窗口大小（默认 32） */
    windowSize?: number;
    /** 最大迭代轮数（默认 2） */
    maxPasses?: number;

    /** 回到基础状态（部署完成、未执行任何动作） */
    resetChain: () => Promise<void>;
    /**
     * 清空链下追踪并**复位所有计数器**（用于最开始的起点）。
     * 通常传 `resetAllForReplay`。
     */
    resetWorld: () => void;
    /** 记录当前链下追踪状态 */
    captureWorld: () => unknown;
    /** 恢复链下追踪状态（与 `captureWorld` 配对） */
    applyWorld: (snap: unknown) => void;
    /** 取 EVM 快照 */
    snapshot: () => Promise<string>;
    /** 回滚到快照 */
    revert: (id: string) => Promise<void>;
    /**
     * 刷新派生视图（通常传 `refreshView`）。
     *
     * **不可省**：某些动作的行为取决于派生视图（如 `advanceTime` 按 phase 决定推进策略）。
     * 重放时若不刷新，动作会读到陈旧视图、采取不同策略，时间线错位、失败无法复现。
     */
    refreshView: () => Promise<unknown>;
}

export interface MinimizeResult {
    /** 最小复现序列（动作名） */
    minimal: string[];
    /** 尝试次数 */
    attempts: number;
    /** 窗口起点能否复现失败；false 表示窗口太小或失败依赖更早的状态 */
    reproduced: boolean;
    /**
     * 最终序列是否**经验证仍能复现失败**。
     *
     * 这个字段是必需的，不是冗余：贪心循环中「最后一次成功删除」之后可能还有
     * 若干次失败尝试，最终留在 `window` 里的序列未必被检查过。没有这一步，
     * 「最小化成功」只是推断而非事实。
     */
    finalVerified: boolean;
    /**
     * 重放是否是确定性的（同一序列两次检查得到相同结果）。
     *
     * **这是最小化可信的前提**。若重放不确定，贪心依据的「删除后仍能复现」
     * 就是随机数——最小化结果毫无意义。故在开始前先自检，不确定则直接放弃，
     * 而不是产出一个看起来像样的错误结果。
     */
    deterministic: boolean;
    /** 原始窗口长度 */
    originalLength: number;
}

/** 调试开关：INV_DEBUG=1 时输出每次重放的逐步骤结果 */
const DEBUG = process.env.INV_DEBUG === "1";

/** 动作执行失败是允许的（删除前置条件后，后续动作自然失败，bug 也就不再触发） */
async function safeRun(action: Action | undefined, rng: Rng): Promise<boolean> {
    if (!action) return false;
    try {
        await action.run(rng);
        return true;
    } catch {
        // 忽略：期待的就是「删掉某些动作后，这条路径走不通了」
        return false;
    }
}

/**
 * 从「窗口起点状态」重放一段动作序列，返回「是否仍能触发任何不变量破坏」。
 *
 * 调用前链下追踪必须已被恢复到窗口起点（由调用方 `applyWorld` 完成）。
 *
 * @param cfg 配置
 * @param byName 动作索引
 * @param indices 要执行的全局步序号
 * @param rngFor 步序号 → 随机源
 * @returns 触发了任一不变量破坏则为 true
 */
async function replayAndCheck(
    cfg: MinimizeConfig,
    byName: Map<string, Action>,
    indices: number[],
    rngFor: (i: number) => Rng
): Promise<boolean> {
    const trace: string[] = [];

    for (const i of indices) {
        // ★ 每步前刷新派生视图，与引擎保持一致。
        //   缺少这一步时，依赖 `view.phase` 的动作（如 advanceTime）会读到陈旧值，
        //   采取与首次运行不同的策略，时间线错位、失败无法复现。
        await cfg.refreshView();
        const ok = await safeRun(byName.get(cfg.sequence[i]), rngFor(i));
        if (DEBUG) trace.push(`#${i}${cfg.sequence[i]}${ok ? "" : "(RVT)"}`);
    }

    let failed = false;
    for (const inv of cfg.invariants) {
        try {
            await inv.check();
        } catch {
            failed = true;
            break;
        }
    }

    if (DEBUG) {
        console.log(`      [debug] ${indices.length} 步 → 复现=${failed}`);
        console.log(`              ${trace.join(" → ")}`);
    }

    return failed;
}

/**
 * 在失败点附近的窗口内最小化复现序列。
 *
 * @param cfg 配置
 * @returns 最小化结果
 */
export async function minimizeFailure(cfg: MinimizeConfig): Promise<MinimizeResult> {
    const windowSize = cfg.windowSize ?? 32;
    const maxPasses = cfg.maxPasses ?? 2;

    const byName = new Map(cfg.actions.map((a) => [a.name, a]));
    // 与引擎完全相同的派生方式——不同则参数错位，失败无法复现
    const rngFor = (i: number): Rng => mulberry32((cfg.seed ^ (i * 0x9e3779b9)) >>> 0);

    const start = Math.max(0, cfg.failIndex - windowSize + 1);

    console.log(
        `\n  ┌─ 失败最小化 ─────────────────────────────────\n` +
            `  │ 失败步   globalStep=${cfg.failIndex}\n` +
            `  │ 窗口     [${start}, ${cfg.failIndex}]（${cfg.failIndex - start + 1} 个动作）\n` +
            `  │ 策略     窗口内贪心删除，上限 ${maxPasses} 轮\n` +
            `  └──────────────────────────────────────────────`
    );

    // 1. 回到基础状态并重放前缀（前缀承载全部前置条件，之后不再重复执行）
    await cfg.resetChain();
    cfg.resetWorld();
    for (let i = 0; i < start; i++) {
        await safeRun(byName.get(cfg.sequence[i]), rngFor(i));
    }

    // 2. 同时固定 EVM 快照与链下追踪快照
    let evmSnap = await cfg.snapshot();
    const worldSnap = cfg.captureWorld();

    // 3. 窗口
    let window: number[] = [];
    for (let i = start; i <= cfg.failIndex; i++) window.push(i);
    const originalLength = window.length;

    /** 回到窗口起点（链 + 链下一起回滚） */
    const rewindToWindowStart = async (): Promise<void> => {
        await cfg.revert(evmSnap);
        // evm_revert 会消耗快照，必须立即重建
        evmSnap = await cfg.snapshot();
        cfg.applyWorld(worldSnap);
    };

    // 4. 确认窗口起点能复现，**并自检重放的确定性**
    //
    //    连续检查两次：若结果不同，说明重放过程中有未被回滚的状态
    //    （链上或链下或派生视图），此时贪心判断依据的是随机结果，
    //    最小化会静默产出错误答案。必须直接放弃而非继续。
    let attempts = 2;
    const first = await replayAndCheck(cfg, byName, window, rngFor);
    await rewindToWindowStart();
    const second = await replayAndCheck(cfg, byName, window, rngFor);
    await rewindToWindowStart();

    if (first !== second) {
        console.log(
            `  │ ⚠️ 重放不确定：同一序列两次检查结果不同（${first} vs ${second}）。\n` +
                `  │    说明某个状态未被回滚 —— 检查 snapshot/revert、captureWorld/applyWorld、\n` +
                `  │    refreshView 是否覆盖了全部影响动作行为的输入。最小化已放弃。\n` +
                `  └──────────────────────────────────────────────`
        );
        return {
            minimal: [],
            attempts,
            reproduced: first,
            finalVerified: false,
            deterministic: false,
            originalLength,
        };
    }

    const reproduced = first;
    if (!reproduced) {
        console.log(
            `  │ ⚠️ 窗口起点无法复现失败 —— 该破坏依赖更早的状态。\n` +
                `  │    请增大 windowSize 后重试。\n` +
                `  └──────────────────────────────────────────────`
        );
        return {
            minimal: window.map((i) => cfg.sequence[i]),
            attempts,
            reproduced: false,
            finalVerified: false,
            deterministic: true,
            originalLength,
        };
    }

    // 5. 贪心删除
    for (let pass = 0; pass < maxPasses; pass++) {
        let removedInPass = 0;

        for (const cand of [...window]) {
            if (window.length <= 1) break;

            const candidate = window.filter((i) => i !== cand);

            await rewindToWindowStart();

            attempts++;
            if (await replayAndCheck(cfg, byName, candidate, rngFor)) {
                window = candidate;
                removedInPass++;
            }
        }

        console.log(
            `  │ 第 ${pass + 1} 轮：删除 ${removedInPass} 个动作，剩余 ${window.length} 个`
        );
        if (removedInPass === 0) break;
    }

    // 6. 自验证：最终序列必须确实能复现失败
    //    （不能只依赖贪心过程中的推断——最后一次成功删除之后可能还有失败尝试）
    await rewindToWindowStart();
    attempts++;
    const finalVerified = await replayAndCheck(cfg, byName, window, rngFor);
    await rewindToWindowStart();

    const minimal = window.map((i) => cfg.sequence[i]);

    console.log(
        `  ├─ 结果 ─────────────────────────────────────\n` +
            `  │ ${originalLength} → ${minimal.length} 个动作（尝试 ${attempts} 次）\n` +
            `  │ 自验证   ${finalVerified ? "✓ 最终序列确实能复现失败" : "✗ 最终序列无法复现"}\n` +
            `  │ ${minimal.join(" → ")}\n` +
            `  └──────────────────────────────────────────────`
    );

    return { minimal, attempts, reproduced: true, finalVerified, deterministic: true, originalLength };
}
