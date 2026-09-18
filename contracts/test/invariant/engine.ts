/**
 * P6 不变量测试引擎 —— 「路径 A：Hardhat + 自研状态机随机测试」
 *
 * 为什么需要自研（而不是用现成工具）：
 *   原方案指定 `forge invariant`，但本机 GitHub 不可达，Foundry 整体不可安装
 *   （见 docs/L5-依赖验证报告.md 与方案 §16 F-22）。Echidna / Medusa 同为 GitHub 分发。
 *   P1 已决策走路径 A，本文件即该路径的引擎实现。
 *
 * 与 `forge invariant` 的能力差距（如实标注，不做等价性声称）：
 *   · Foundry 在 EVM 字节码层面做「调用序列模糊」，能发现 ABI 之外的畸形输入
 *   · 本引擎在 ethers 层面构造**合法 ABI** 的调用，故无法覆盖畸形 calldata
 *   · 补偿：本引擎可断言「链下追踪状态」与「链上状态」的一致性（见 INV-1/3/4），
 *     而纯模糊测试通常只能断言链上状态之间的关系
 *
 * 三条硬约束（方案 §16.5，P1 派生）：
 *   【硬约束 7】随机测试必须固定并打印 seed；CI 失败时能用该 seed 100% 复现
 *   【硬约束 8】每条不变量必须有具名断言函数，且被每轮动作后**无条件**调用
 *   【硬约束 9】动作集必须覆盖全部状态变更入口 + 非法时序/越权动作
 */

/**
 * 确定性伪随机数生成器（mulberry32）。
 *
 * 为什么不用 `Math.random()`：不可复现。CI 失败时无法重跑同一序列，
 * 随机测试就退化成了「偶发失败的测试」——比没有测试更糟（会训练团队忽略红灯）。
 *
 * mulberry32 的特性：32 位内部状态，周期 2^32，分布足够均匀，
 * 且实现只有 6 行（不引入依赖，避免为一个测试工具增加供应链面）。
 *
 * @param seed 种子（32 位无符号）
 * @returns 均匀分布于 [0, 1) 的随机数生成函数
 */
export function mulberry32(seed: number): Rng {
    let a = seed >>> 0;
    return function next(): number {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 确定性随机源 */
export type Rng = () => number;

/**
 * 一条不变量的具名断言。
 * @property id 编号，如 `INV-1`
 * @property name 中文名，如「票数守恒」
 * @property check 断言体。**失败必须抛错**（由 assertAll 统一包装并附上 seed）
 */
export interface Invariant {
    id: string;
    name: string;
    check: () => Promise<void>;
}

/**
 * 一个状态机动作。
 *
 * @property kind
 *   - `legal`：允许成功也允许 revert（时序不满足时 revert 是合理的）
 *   - `mustRevert`：**必须 revert**。成功执行即判为失败——这类动作是「对抗性动作」，
 *     用于验证合约确实拒绝了越权 / 伪造 / 重复 / 非法时序的调用。
 *     若它成功了，说明某道防护失效。
 * @property weight 当前世界状态下该动作的权重。返回 0 表示不适用（不会被选中）。
 *   用权重而非布尔开关，是为了让随机序列能集中在「当前阶段最有意义的动作」上，
 *   从而在有限的轮次内真正穿越完整流程（而非把 90% 的调用浪费在必然 revert 的动作上）。
 * @property run 动作体
 */
export interface Action {
    name: string;
    kind: "legal" | "mustRevert";
    weight: () => number;
    run: (rng: Rng) => Promise<void>;
}

/** 单次战役的统计结果 */
export interface RunStats {
    seed: number;
    rounds: number;
    actionsPerRound: number;
    totalActions: number;
    /** 每个动作的执行次数与 revert 次数 */
    perAction: Record<string, { ok: number; revert: number }>;
    /** 每条不变量被检查的次数 */
    perInvariant: Record<string, number>;
    /** 战役结束时的阶段分布，用于确认流程确实被穿越 */
    phaseHits: Record<number, number>;
}

/** 战役配置 */
export interface CampaignConfig {
    /**
     * 种子。默认由 `INV_SEED` 环境变量覆盖，否则用固定常量。
     * **固定默认值是刻意的**：CI 必须可复现；探索新序列时显式设 `INV_SEED`。
     */
    seed: number;
    /** 轮数 */
    rounds: number;
    /** 每轮动作数 */
    actionsPerRound: number;
    actions: Action[];
    invariants: Invariant[];
    /**
     * 每次选动作前刷新「链上视图」并返回当前阶段编号。
     *
     * 为什么需要它：`weight()` 必须是同步函数（避免为每个动作都做异步判断），
     * 但可用动作取决于当前阶段与时间。因此在选动作前先刷新一次视图，
     * `weight()` 再读刷新后的快照。
     *
     * 返回值用于统计「阶段分布」，从而确认随机序列确实穿越了完整流程
     * （若 512×64 次动作里有 90% 停在 REGISTRATION，说明权重设计有问题）。
     */
    refresh: () => Promise<number>;
}

/** 可复现的默认种子 */
export const DEFAULT_SEED = 0xc0ffee;

/**
 * 解析本次战役使用的种子。
 *
 * 【硬约束 7】支持 `INV_SEED` 覆盖，便于 CI 失败后做探索；
 * 但**默认值必须固定**，否则「可复现」无从谈起。
 *
 * @returns 种子值
 */
export function resolveSeed(): number {
    const raw = process.env.INV_SEED;
    if (raw === undefined || raw === "") return DEFAULT_SEED;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`INV_SEED 不是有效数字: ${raw}`);
    }
    return parsed >>> 0;
}

/**
 * 按权重选择一个动作。
 * @param rng 随机源
 * @param actions 候选动作（权重为 0 的会被排除）
 * @returns 选中的动作
 */
function pickWeighted(rng: Rng, actions: Action[]): Action {
    const candidates = actions
        .map((a) => ({ a, w: Math.max(0, a.weight()) }))
        .filter((x) => x.w > 0);

    if (candidates.length === 0) {
        throw new Error("没有任何可用动作（全部权重为 0）—— 动作集覆盖不完整");
    }

    const total = candidates.reduce((s, x) => s + x.w, 0);
    let r = rng() * total;
    for (const c of candidates) {
        r -= c.w;
        if (r <= 0) return c.a;
    }
    return candidates[candidates.length - 1].a;
}

/**
 * 执行一次完整的随机战役。
 *
 * 流程：逐轮逐动作 → 执行 → 判定 kind 是否满足 → **无条件调用全部不变量断言**。
 *
 * 【硬约束 8】断言在**每一次动作之后**调用，而不是「每轮一次」：
 * 破坏不变量往往发生在某一次具体操作上，每轮一次会漏掉中间态。
 * 这也是 assertAll 内部会统计次数的原因——`perInvariant` 应等于 `totalActions`，
 * 若不等则说明调度逻辑被改坏了（由主测试断言）。
 *
 * @param cfg 战役配置
 * @returns 统计结果
 */
export async function runInvariantCampaign(cfg: CampaignConfig): Promise<RunStats> {
    const rng = mulberry32(cfg.seed);

    const stats: RunStats = {
        seed: cfg.seed,
        rounds: cfg.rounds,
        actionsPerRound: cfg.actionsPerRound,
        totalActions: 0,
        perAction: {},
        perInvariant: {},
        phaseHits: {},
    };

    console.log(
        `\n  ┌─ 不变量战役 ─────────────────────────────────\n` +
            `  │ seed = ${cfg.seed} (0x${cfg.seed.toString(16)})` +
            `${process.env.INV_SEED ? "  [由 INV_SEED 覆盖]" : ""}\n` +
            `  │ ${cfg.rounds} 轮 × ${cfg.actionsPerRound} 动作 = ${cfg.rounds * cfg.actionsPerRound} 次\n` +
            `  │ 复现命令: INV_SEED=${cfg.seed} npx hardhat test test/p6.invariants.test.ts\n` +
            `  └──────────────────────────────────────────────`
    );

    for (let round = 0; round < cfg.rounds; round++) {
        for (let step = 0; step < cfg.actionsPerRound; step++) {
            // 选动作前刷新链上视图，使 weight() 能基于最新的阶段/时间决策
            const phaseNow = await cfg.refresh();
            stats.phaseHits[phaseNow] = (stats.phaseHits[phaseNow] ?? 0) + 1;

            const action = pickWeighted(rng, cfg.actions);

            const slot = (stats.perAction[action.name] ??= { ok: 0, revert: 0 });

            let reverted = false;
            let failure: unknown;

            try {
                await action.run(rng);
            } catch (e) {
                reverted = true;
                failure = e;
            }

            // 对抗性动作成功执行 = 某道防护失效，立即失败并给出可复现坐标
            if (action.kind === "mustRevert" && !reverted) {
                throw new Error(
                    `[seed=${cfg.seed} round=${round} step=${step}] ` +
                        `对抗性动作「${action.name}」本应被拒绝，却成功执行了。\n` +
                        `复现: INV_SEED=${cfg.seed} npx hardhat test test/p6.invariants.test.ts`
                );
            }

            if (reverted) slot.revert++;
            else slot.ok++;

            stats.totalActions++;

            // 【硬约束 8】每次动作后无条件检查全部不变量
            await assertAll(cfg.invariants, stats, {
                seed: cfg.seed,
                round,
                step,
                action: action.name,
                // 对抗性动作的 revert 是预期内的；但它仍可能留下中间态，故一并记录
                note: reverted && failure instanceof Error ? failure.message.slice(0, 200) : undefined,
            });
        }
    }

    return stats;
}

/**
 * 无条件执行全部不变量断言。
 *
 * @param invariants 不变量清单
 * @param stats 统计对象（用于记录每条被检查的次数）
 * @param where 失败时用于定位的坐标信息
 */
async function assertAll(
    invariants: Invariant[],
    stats: RunStats,
    where: { seed: number; round: number; step: number; action: string; note?: string }
): Promise<void> {
    for (const inv of invariants) {
        stats.perInvariant[inv.id] = (stats.perInvariant[inv.id] ?? 0) + 1;

        try {
            await inv.check();
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            throw new Error(
                `\n【不变量被破坏】${inv.id} ${inv.name}\n` +
                    `  坐标  : seed=${where.seed} round=${where.round} step=${where.step}\n` +
                    `  触发于: 动作「${where.action}」之后\n` +
                    (where.note ? `  动作备注: ${where.note}\n` : "") +
                    `  复现  : INV_SEED=${where.seed} npx hardhat test test/p6.invariants.test.ts\n` +
                    `  详情  : ${detail}`
            );
        }
    }
}
