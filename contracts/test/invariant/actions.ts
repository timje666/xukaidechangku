/**
 * P6 动作集 —— 状态机随机测试的「可执行操作」
 *
 * 【硬约束 9】动作集必须覆盖**全部状态变更入口**
 *   `registerVoters` / `freezeVotersRoot` / `castVote` / `reveal` / `finalize`
 * 并包含**非法时序**与**越权**动作，否则无法验证 INV-5（阶段单调）与各类 revert 分支。
 *
 * 两类动作（见 engine.ts 的 `Action.kind`）：
 *   · `legal`      —— 允许成功也允许 revert（时序不满足时 revert 合理）
 *   · `mustRevert` —— **必须 revert**。这类是「对抗性动作」：若它成功了，
 *                     说明某道防护失效（越权、伪造票据、重复提交、非法时序）。
 *
 * 权重设计（`weight()`）的作用：把有限的轮次集中在「当前阶段有意义」的动作上。
 * 若所有动作等权，随机序列会有一大半消耗在必然 revert 的调用上，
 * 512×64 次仍可能从未走到揭示期——那样随机测试只是「跑了很多次」，没有覆盖面。
 * 阶段分布由主测试断言（每个阶段都必须被访问到）。
 */

import { time } from "@nomicfoundation/hardhat-network-helpers";

import type { Action, Rng } from "./engine";
import { readCounts } from "./invariants";
import {
    type World,
    computeCommitment,
    nextAddress,
    nextCommitment,
    nextNullifier,
    nextSalt,
    resetTrackingForNewLifecycle,
} from "./world";

/** 阶段枚举，与 `Proposal.Phase` 一致 */
export const PHASE = {
    REGISTRATION: 0,
    IDLE: 1,
    VOTING: 2,
    REVEAL: 3,
    CLOSED: 4,
    FINALIZED: 5,
} as const;

/** RevealStatus 枚举，与 `Proposal.RevealStatus` 一致 */
const STATUS = { NONE: 0, ACCEPTED: 1, REJECTED: 2 } as const;

/** 名册人数上限，避免测试后期动作变得极慢 */
const MAX_ROSTER = 200;

/**
 * 构造一个结构完整、内容任意的 Semaphore 证明。
 * `MockVerifier` 不校验证明内容（除非开启 strictMode），故 points 用常量。
 * @param o 关键字段
 * @returns 证明对象
 */
function makeProof(o: { root: bigint; scope: bigint; nullifier: bigint; message: bigint }) {
    return {
        merkleTreeDepth: 20n,
        merkleTreeRoot: o.root,
        nullifier: o.nullifier,
        message: o.message,
        scope: o.scope,
        points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
    };
}

/**
 * 生成一个选票位图。
 *
 * `legalBias` 决定合法位图的比例。诚实投票用 0.7（保留 30% 触发「揭示期作废」路径），
 * 其余场景用 1.0（位图本身不是该动作要测的点）。
 *
 * @param w 世界状态
 * @param rng 随机源
 * @param legalBias 合法概率
 * @returns 位图
 */
function pickMask(w: World, rng: Rng, legalBias = 0.7): number {
    if (rng() < legalBias) {
        const k = 1 + Math.floor(rng() * w.maxChoices);
        const idx = Array.from({ length: w.optionCount }, (_, i) => i);
        for (let i = 0; i < k; i++) {
            const j = i + Math.floor(rng() * (idx.length - i));
            [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        let m = 0;
        for (let i = 0; i < k; i++) m |= 1 << idx[i];
        return m;
    }

    // 不合法：越界位 或 超选择数
    if (rng() < 0.5) {
        return 1 << w.optionCount;
    }
    // 取 maxChoices+1 个连续位；若超出 optionCount 则退化为全选（仍超限）
    const k = Math.min(w.optionCount, w.maxChoices + 1);
    return (1 << k) - 1;
}

/**
 * 构造完整动作集。
 * @param w 世界状态（动作通过闭包读写它）
 * @returns 动作数组
 */
export function buildActions(w: World): Action[] {
    return [
        // ------------------------------------------------------------
        // 登记入口
        // ------------------------------------------------------------
        {
            name: "registerVoters",
            kind: "legal",
            weight: () =>
                w.view.timestamp < w.times.registrationEnd && w.registeredAddresses.length < MAX_ROSTER
                    ? 40
                    : 0,
            run: async (rng: Rng) => {
                const batch: string[] = [];
                const commits: bigint[] = [];

                // 首次登记时把 registeredSigner 写入名册，
                // 使「已登记地址直投必拒」（硬约束 10）可被验证
                if (!w.signerRegistered) {
                    batch.push(w.registeredSigner.address);
                    commits.push(nextCommitment(w));
                    w.signerRegistered = true;
                }

                const n = 1 + Math.floor(rng() * 3);
                for (let i = 0; i < n; i++) {
                    batch.push(nextAddress(w));
                    commits.push(nextCommitment(w));
                }

                await w.registry.connect(w.registrar).registerVoters(batch, commits);

                // 仅在成功后记录（失败即整笔回滚，链下不应留下痕迹）
                w.registeredAddresses.push(...batch);
                w.registeredCommitments.push(...commits);
            },
        },
        {
            name: "registerVoters(越权)",
            kind: "mustRevert",
            weight: () => (w.view.timestamp < w.times.registrationEnd ? 12 : 0),
            run: async () => {
                // 无 REGISTRAR_ROLE 的账户调用，必须被 AccessControl 拒绝
                await w.registry
                    .connect(w.outsider)
                    .registerVoters([nextAddress(w)], [nextCommitment(w)]);
            },
        },

        // ------------------------------------------------------------
        // 名册冻结
        // ------------------------------------------------------------
        {
            name: "freezeVotersRoot",
            kind: "legal",
            weight: () =>
                w.view.timestamp >= w.times.registrationEnd && !w.view.frozen && w.view.rosterSize > 0n
                    ? 60
                    : 0,
            run: async () => {
                await w.registry.freezeVotersRoot();
                w.frozenRootSnapshot = BigInt(await w.registry.frozenRoot());
            },
        },
        {
            name: "freezeVotersRoot(重复)",
            kind: "mustRevert",
            // 限定在「已冻结但尚未封存」的窗口内：
            // 若不限定，封存后本动作仍可抽中，会与唯一能推进流程的 spawnLifecycle
            // 抢占名额（实测 512×64 中它占了 15285/32768 次，其中大半发生在终态上）
            weight: () => (w.view.frozen && !w.view.finalized ? 10 : 0),
            run: async () => {
                await w.registry.freezeVotersRoot();
            },
        },

        // ------------------------------------------------------------
        // 投票入口
        // ------------------------------------------------------------
        {
            name: "castVote(诚实)",
            kind: "legal",
            weight: () => (w.view.phase === PHASE.VOTING && w.view.frozen ? 50 : 0),
            run: async (rng: Rng) => {
                const nullifier = nextNullifier(w);
                const mask = pickMask(w, rng);
                const salt = nextSalt(w);
                const commitment = await computeCommitment(w, mask, salt);
                const root = BigInt(await w.registry.frozenRoot());

                await w.proposal
                    .connect(w.relayer)
                    .castVote(
                        makeProof({ root, scope: w.scope, nullifier, message: BigInt(commitment) })
                    );

                w.castedBallots.push({ nullifier, commitment, mask, salt });
            },
        },
        {
            name: "castVote(已登记地址直投)",
            kind: "mustRevert",
            weight: () =>
                w.view.phase === PHASE.VOTING && w.signerRegistered && w.view.frozen ? 20 : 0,
            run: async (rng: Rng) => {
                // ★硬约束 10：已登记地址直投会把「地址 ↔ 选票」公开关联，必须被拒
                const nullifier = nextNullifier(w);
                const mask = pickMask(w, rng, 1.0);
                const salt = nextSalt(w);
                const commitment = await computeCommitment(w, mask, salt);
                const root = BigInt(await w.registry.frozenRoot());

                await w.proposal
                    .connect(w.registeredSigner)
                    .castVote(
                        makeProof({ root, scope: w.scope, nullifier, message: BigInt(commitment) })
                    );
            },
        },
        {
            name: "castVote(重复 nullifier)",
            kind: "mustRevert",
            weight: () =>
                w.view.phase === PHASE.VOTING && w.castedBallots.length > 0 && w.view.frozen ? 15 : 0,
            run: async (rng: Rng) => {
                const dup = w.castedBallots[0];
                const mask = pickMask(w, rng);
                const salt = nextSalt(w);
                const commitment = await computeCommitment(w, mask, salt);
                const root = BigInt(await w.registry.frozenRoot());

                await w.proposal
                    .connect(w.relayer)
                    .castVote(
                        makeProof({
                            root,
                            scope: w.scope,
                            nullifier: dup.nullifier,
                            message: BigInt(commitment),
                        })
                    );
            },
        },
        {
            name: "castVote(错误 scope)",
            kind: "mustRevert",
            weight: () => (w.view.phase === PHASE.VOTING && w.view.frozen ? 15 : 0),
            run: async (rng: Rng) => {
                // 在 scope 处失败 → 验证未通过 → 该 nullifier 不得被标记（INV-9 检验点）
                const nullifier = nextNullifier(w);
                const mask = pickMask(w, rng, 1.0);
                const salt = nextSalt(w);
                const commitment = await computeCommitment(w, mask, salt);
                const root = BigInt(await w.registry.frozenRoot());

                try {
                    await w.proposal
                        .connect(w.relayer)
                        .castVote(
                            makeProof({
                                root,
                                scope: w.scope + 1n,
                                nullifier,
                                message: BigInt(commitment),
                            })
                        );
                } catch (e) {
                    w.failedNullifiers.push(nullifier);
                    throw e;
                }
            },
        },
        {
            name: "castVote(错误根)",
            kind: "mustRevert",
            weight: () => (w.view.phase === PHASE.VOTING && w.view.frozen ? 10 : 0),
            run: async (rng: Rng) => {
                const nullifier = nextNullifier(w);
                const mask = pickMask(w, rng, 1.0);
                const salt = nextSalt(w);
                const commitment = await computeCommitment(w, mask, salt);
                const root = BigInt(await w.registry.frozenRoot());

                try {
                    await w.proposal
                        .connect(w.relayer)
                        .castVote(
                            makeProof({
                                root: root + 1n,
                                scope: w.scope,
                                nullifier,
                                message: BigInt(commitment),
                            })
                        );
                } catch (e) {
                    w.failedNullifiers.push(nullifier);
                    throw e;
                }
            },
        },

        // ------------------------------------------------------------
        // 揭示入口
        // ------------------------------------------------------------
        {
            name: "reveal(诚实)",
            kind: "legal",
            weight: () => (w.view.phase === PHASE.REVEAL && pendingRevealCount(w) > 0 ? 50 : 0),
            run: async (rng: Rng) => {
                const pending = w.castedBallots.filter(
                    (b) =>
                        !w.acceptedBallots.some((a) => a.commitment === b.commitment) &&
                        !w.rejectedCommitments.includes(b.commitment)
                );
                if (pending.length === 0) return;

                const b = pending[Math.floor(rng() * pending.length)];
                await w.proposal.reveal([
                    { ballotCommitment: b.commitment, ballotMask: b.mask, salt: b.salt },
                ]);

                // 按链上实际状态归类：合法 → ACCEPTED，超限/越界 → REJECTED
                const status = Number(await w.proposal.revealStatusOf(b.commitment));
                if (status === STATUS.ACCEPTED) w.acceptedBallots.push(b);
                else if (status === STATUS.REJECTED) w.rejectedCommitments.push(b.commitment);
            },
        },
        {
            name: "reveal(伪造承诺)",
            kind: "mustRevert",
            weight: () => (w.view.phase === PHASE.REVEAL ? 25 : 0),
            run: async (rng: Rng) => {
                // ★F-02 回归点：自造 (mask, salt) 与承诺，从未在投票期上链。
                // 若无 `_commitmentCast` 校验，此调用会成功并「凭空造票」。
                const mask = pickMask(w, rng, 1.0);
                const salt = nextSalt(w);
                const forged = await computeCommitment(w, mask, salt);

                await w.proposal.reveal([
                    { ballotCommitment: forged, ballotMask: mask, salt },
                ]);
            },
        },
        {
            name: "reveal(重复)",
            kind: "mustRevert",
            weight: () =>
                w.view.phase === PHASE.REVEAL &&
                w.acceptedBallots.length + w.rejectedCommitments.length > 0
                    ? 12
                    : 0,
            run: async () => {
                const b = w.acceptedBallots[0] ?? castedByCommitment(w, w.rejectedCommitments[0]);
                const payload =
                    "ballotCommitment" in b
                        ? { ballotCommitment: b.commitment, ballotMask: b.mask, salt: b.salt }
                        : b;
                await w.proposal.reveal([payload]);
            },
        },
        {
            name: "reveal(时序非法)",
            kind: "mustRevert",
            weight: () =>
                w.view.phase === PHASE.REGISTRATION ||
                w.view.phase === PHASE.IDLE ||
                w.view.phase === PHASE.VOTING
                    ? 8
                    : 0,
            run: async (rng: Rng) => {
                const mask = pickMask(w, rng, 1.0);
                const salt = nextSalt(w);
                const c = await computeCommitment(w, mask, salt);
                await w.proposal.reveal([{ ballotCommitment: c, ballotMask: mask, salt }]);
            },
        },

        // ------------------------------------------------------------
        // 封存入口
        // ------------------------------------------------------------
        {
            name: "finalize",
            kind: "legal",
            weight: () =>
                w.view.timestamp >= w.times.revealEnd && !w.view.finalized ? 60 : 0,
            run: async () => {
                await w.proposal.finalize();
                w.finalizeOkCount++;
                w.countsAfterFinalize = await readCounts(w);
                w.resultHashAfterFinalize = await w.proposal.resultHash();
            },
        },
        {
            name: "finalize(重复)",
            kind: "mustRevert",
            weight: () => (w.view.finalized ? 8 : 0),
            run: async () => {
                await w.proposal.finalize();
            },
        },
        {
            name: "finalize(时序非法)",
            kind: "mustRevert",
            weight: () =>
                w.view.timestamp < w.times.revealEnd && w.view.phase !== PHASE.FINALIZED ? 8 : 0,
            run: async () => {
                await w.proposal.finalize();
            },
        },
        {
            name: "spawnLifecycle(重启提案)",
            kind: "legal",
            /**
             * 流程终结后必须重启，否则剩余轮次全部空转。
             *
             * ★实测教训：首版没有这个动作，512×64 战役里 78% 的动作发生在已封存的
             * 提案上（重复 finalize 12317 次 + 重复 freeze 15285 次 + noop 5131 次），
             * 真正有价值的动作只有两位数——registerVoters 2 次、castVote 10 次、
             * reveal 3 次、finalize 1 次。**只覆盖了一个生命周期。**
             * 「跑了 32768 次」不等于「覆盖了 32768 种状态」。
             */
            weight: () => (w.view.phase === PHASE.FINALIZED ? 80 : 0),
            run: async () => {
                await w.spawn();
                resetTrackingForNewLifecycle(w);
                w.lifecycleCount++;
            },
        },

        // ------------------------------------------------------------
        // 时间推进与空操作
        // ------------------------------------------------------------
        {
            name: "advanceTime",
            kind: "legal",
            weight: () => {
                const t = w.view.timestamp;
                // 四个边界都已耗尽时，推进无意义。
                // 若此处仍返回高权重，它会与 `finalize` 竞争抽签名额——而 `finalize`
                // 是 CLOSED 阶段唯一能推进流程的动作（揭示期后若不封存，
                // 随机序列会永远卡在 CLOSED，INV-6 也就永远得不到验证）。
                if (t >= w.times.revealEnd) return 0;

                if (t < w.times.registrationEnd) return 25;
                // 空档期（IDLE）无事可做，权重拉高以尽快穿越
                if (t < w.times.votingStart) return 90;
                // 投票期/揭示期压低，保留动作机会
                return 18;
            },
            run: async (rng: Rng) => {
                const t = BigInt(await time.latest());
                const targets = [
                    w.times.registrationEnd,
                    w.times.votingStart,
                    w.times.votingEnd,
                    w.times.revealEnd,
                ];
                const next = targets.find((x) => x > t);
                if (next === undefined) return;

                if (rng() < 0.5) {
                    await time.increaseTo(next);
                } else {
                    const step = BigInt(60 + Math.floor(rng() * 1800));
                    await time.increaseTo(t + step > next ? next : t + step);
                }
            },
        },
        {
            name: "noop",
            kind: "legal",
            weight: () => 5,
            run: async () => {
                // 空操作：保证任何阶段都至少有一个可用动作
            },
        },
    ];
}

/** 尚未揭示的已上链票据数 */
function pendingRevealCount(w: World): number {
    return w.castedBallots.filter(
        (b) =>
            !w.acceptedBallots.some((a) => a.commitment === b.commitment) &&
            !w.rejectedCommitments.includes(b.commitment)
    ).length;
}

/** 从已上链票据里按承诺查回完整记录 */
function castedByCommitment(w: World, commitment: string | undefined) {
    const b = w.castedBallots.find((x) => x.commitment === commitment);
    return b
        ? { ballotCommitment: b.commitment, ballotMask: b.mask, salt: b.salt }
        : { ballotCommitment: commitment ?? "0x" + "00".repeat(32), ballotMask: 0, salt: 0n };
}
