/**
 * P6c · 失败最小化器验证
 *
 * ## 为什么要专门写一个测试来验证「最小化器」
 *
 * 最小化器是**调试工具**——真实不变量测试不通过时才会用到它。这意味着：
 *   · 在 P6 的正常运行中它**从不执行**
 *   · 一个从未执行过的调试工具，等真需要时大概率是坏的
 *
 * 所以必须主动构造一个人为的失败来验证它工作。做法是注入一条**合成不变量**：
 * 「票据数必须 < 3」——它在第 3 张票上链后必然破坏，且触发条件明确可断言。
 *
 * 这样验的是三件事：
 *   1. 最小化器能从「窗口」收缩出更短的序列
 *   2. 收缩后的序列**确实仍能复现**（`finalVerified`，而非推断）
 *   3. 收缩**没有删过头**：前置条件（登记、冻结、推进时间）必须保留，
 *      无关动作（noop）必须删掉，触发所需的动作次数必须恰好
 *
 * 第 3 点尤其重要：一个「删到什么都不剩」的最小化器也能让 `finalVerified` 为 false，
 * 但一个「删过头导致不再复现」的最小化器会静默返回无效结果。
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { buildProposalInit, buildTimeWindows } from "./helpers/proposal";
import { buildActions } from "./invariant/actions";
import { evmRevert, evmSnapshot } from "./invariant/calldata-fuzz";
import { type Invariant, reportFailures, runInvariantCampaign } from "./invariant/engine";
import { minimizeFailure } from "./invariant/minimizer";
import {
    applyTracking,
    captureTracking,
    createWorld,
    refreshView,
    resetAllForReplay,
} from "./invariant/world";

describe("P6c · 失败最小化器（收缩能力的替代实现）", function () {
    this.timeout(0);

    let base: any;
    let baseSnap: string;

    /**
     * 只部署，**不登记、不冻结、不推进时间**。
     *
     * 这是刻意的：若在 fixture 里预先登记并冻结，`registerVoters` / `freezeVotersRoot`
     * 就不在动作序列里了，最小化器「保留前置条件」这一关键性质便无从验证。
     * （首版正是如此，结果最小序列里没有它们——不是最小化器错了，而是测试场景设计错了。）
     */
    async function deployFixture() {
        const [admin, registrar, relayer] = await ethers.getSigners();

        const PT3 = await ethers.getContractFactory("PoseidonT3");
        const pt3 = await PT3.deploy();
        await pt3.waitForDeployment();
        const pt3Addr = await pt3.getAddress();

        const PT4 = await ethers.getContractFactory("PoseidonT4");
        const pt4 = await PT4.deploy();
        await pt4.waitForDeployment();
        const pt4Addr = await pt4.getAddress();

        const MV = await ethers.getContractFactory("MockVerifier");
        const verifier = await MV.deploy();
        await verifier.waitForDeployment();

        const now = BigInt(await time.latest());
        const tw = buildTimeWindows(now);

        const R = await ethers.getContractFactory("VoterRegistry", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const registry = await R.deploy(admin.address, tw.registrationEnd);
        await registry.waitForDeployment();

        const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE"));
        await registry.connect(admin).grantRole(REGISTRAR_ROLE, registrar.address);

        // Proposal 必须在推进时间之前部署（构造时校验 registrationEnd - now >= 下限）
        const P = await ethers.getContractFactory("ProposalHarness", {
            libraries: { PoseidonT4: pt4Addr },
        });
        const proposal = await P.deploy(
            admin.address,
            buildProposalInit({
                proposalId: 1n,
                registry: await registry.getAddress(),
                verifier: await verifier.getAddress(),
                ...tw,
            })
        );
        await proposal.waitForDeployment();

        return {
            registry,
            proposal,
            pt4,
            scope: (await proposal.SCOPE()) as bigint,
            tw,
            admin,
            registrar,
            relayer,
        };
    }

    before(async function () {
        base = await deployFixture();
        baseSnap = await evmSnapshot();
    });

    it("能把失败序列收缩到最小复现集，且保留前置条件、删除无关动作", async function () {
        const SEED = 0x5eed1;

        const world = createWorld({
            registry: base.registry,
            proposal: base.proposal,
            pt4: base.pt4,
            scope: base.scope,
            optionCount: 4,
            maxChoices: 2,
            times: base.tw,
            registeredSigner: base.admin,
            relayer: base.relayer,
            outsider: base.registrar,
            registrar: base.registrar,
            spawn: async () => {},
        });
        await refreshView(world);

        // 窄动作集：排除 spawnLifecycle（它会替换合约引用，使「回滚到窗口起点」
        // 失去意义——快照恢复的是旧合约的状态）。最小化器与生命周期重启是两件事，
        // 不该在一个测试里同时验证。
        const NARROW = [
            "registerVoters",
            "freezeVotersRoot",
            "castVote(诚实)",
            "reveal(诚实)",
            "finalize",
            "advanceTime",
            "noop",
        ];
        const actions = buildActions(world).filter((a) => NARROW.includes(a.name));
        expect(actions.length, "窄动作集不应为空").to.be.greaterThan(0);

        // 合成不变量：第 1 次揭示完成即破坏。
        //
        // 为什么不用「票据数 >= 3」：单个生命周期的投票期只能容纳 2~4 票
        // （实测某些 seed 下只有 2 票），触发与否取决于运气；而本测试若要可靠，
        // 必须选一个**在当前序列中必然发生**的事件。
        // 「第 1 次揭示」恰好满足：它只需要 1 票，且要求完整的前置链
        // （登记 → 冻结 → 推进到投票期 → 投票 → 推进到揭示期 → 揭示），
        // 因此最小化结果仍能验证「前置条件不可删」这一关键性质。
        const synthetic: Invariant = {
            id: "INV-SYNTH",
            name: "揭示数必须为 0（合成，仅用于验证最小化器）",
            check: async () => {
                const n = BigInt(await base.proposal.revealedCount());
                if (n >= 1n) throw new Error(`合成失败：已有 ${n} 票完成揭示`);
            },
        };

        // ---- 1. collect 模式战役，捕获失败 ----
        //
        // 规模说明：需要 3 票才触发，而单个生命周期的投票期只能容纳 2~4 票
        // （实测 80 步时只有 2 票，差一票）。故取 25 轮 × 8 = 200 步，
        // 跨越 2~3 个生命周期以确保必然触发——本测试的目的是验证最小化器，
        // 不该依赖「恰好投满 3 票」的运气。
        const stats = await runInvariantCampaign({
            seed: SEED,
            rounds: 25,
            actionsPerRound: 8,
            actions,
            invariants: [synthetic],
            mode: "collect",
            refresh: () => refreshView(world),
        });
        reportFailures(stats);

        // 诊断输出：失败时最需要知道的是「流程走到哪一步停住了」
        console.log("  ┌─ 动作统计（诊断）──────────────────────────");
        for (const [n, s] of Object.entries(stats.perAction).sort()) {
            console.log(`  │ ${n.padEnd(20)} ok=${String(s.ok).padStart(3)} revert=${String(s.revert).padStart(3)}`);
        }
        console.log(
            `  │ 阶段分布: ${JSON.stringify(stats.phaseHits)}\n` +
                `  └────────────────────────────────────────────`
        );

        expect(stats.failures.length, "合成不变量应被触发").to.be.greaterThan(0);
        const first = stats.failures[0];
        expect(first.invariant).to.equal("INV-SYNTH");
        expect(first.precedingActions.length, "失败记录应带前置动作窗口").to.be.greaterThan(0);

        // ---- 2. 最小化 ----
        // windowSize 取足够大，使窗口覆盖到序列起点
        // —— 这样得到的 minimal 是「从零开始的最小复现序列」，断言可以很强
        const result = await minimizeFailure({
            seed: SEED,
            actions,
            invariants: [synthetic],
            sequence: stats.actionSequence,
            failIndex: first.globalStep,
            windowSize: 999,
            maxPasses: 2,
            resetChain: async () => {
                await evmRevert(baseSnap);
                // evm_revert 消耗快照，必须立即重建
                baseSnap = await evmSnapshot();
            },
            resetWorld: () => resetAllForReplay(world),
            captureWorld: () => captureTracking(world),
            applyWorld: (s) => applyTracking(world, s),
            snapshot: evmSnapshot,
            revert: evmRevert,
            // 必须传：advanceTime 按 view.phase 决定推进策略，视图不刷新则重放行为不一致
            refreshView: () => refreshView(world),
        });

        // ---- 3. 断言 ----

        // (a) 窗口起点能复现（否则后面的结论都不成立）
        expect(result.reproduced, "窗口起点应能复现失败").to.equal(true);

        // (b) ★ 自验证：最终序列确实能复现失败，而非仅由贪心过程推断
        expect(result.finalVerified, "最小序列必须经验证仍能复现失败").to.equal(true);

        // (c) 确实收缩了（原窗口是 failIndex+1 个动作）
        expect(
            result.minimal.length,
            `应短于原序列（原 ${result.originalLength} 个）`
        ).to.be.lessThan(result.originalLength);

        // (d) ★ 前置条件不可被删除，且不应有冗余
        const regCount = result.minimal.filter((n) => n === "registerVoters").length;
        expect(regCount, "登记是不可或缺的前置，且应恰好保留 1 次").to.equal(1);

        const freezeCount = result.minimal.filter((n) => n === "freezeVotersRoot").length;
        expect(freezeCount, "冻结根是投票的必要前置，且应恰好保留 1 次").to.equal(1);

        // (e) 无关动作必须被删除
        expect(result.minimal.includes("noop"), "空操作应被最小化删除").to.equal(false);

        // (f) 触发所需的动作次数应恰好（少一次不触发，多一次是冗余）
        const castCount = result.minimal.filter((n) => n === "castVote(诚实)").length;
        expect(castCount, `揭示需要恰好 1 张票，实际 ${castCount} 次投票`).to.equal(1);

        const revealCount = result.minimal.filter((n) => n === "reveal(诚实)").length;
        expect(revealCount, `触发条件是 1 次揭示，实际 ${revealCount} 次`).to.equal(1);

        // (g) 最小序列规模合理：登记 + 若干次推进时间 + 冻结 + 投票 + 揭示
        expect(result.minimal.length, "最小序列不应超过 12 个动作").to.be.lessThanOrEqual(12);
    });
});
