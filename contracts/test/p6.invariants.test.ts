/**
 * P6 不变量与状态机随机测试 —— 「路径 A」主测试
 *
 * 为什么不用 `forge invariant`：本机 GitHub 不可达，Foundry 整体不可安装
 * （见 docs/L5-依赖验证报告.md 与方案 §16 F-22）。Echidna / Medusa 同为 GitHub 分发。
 * P1 已决策走路径 A（Hardhat + 自研状态机随机测试），本文件即该路径的落地。
 *
 * 规模控制：
 *   INV_ROUNDS   轮数（默认 128）
 *   INV_ACTIONS  每轮动作数（默认 32）
 *   INV_SEED     种子（默认见 engine.DEFAULT_SEED，固定以保证可复现）
 *   INV_FULL=1   启用 DoD 完整规模 512×64 的额外战役
 *
 * 默认规模（4096 次动作，实测约 70 秒）刻意小于 DoD：`npm test` 需要能在
 * 日常开发中反复运行。完整规模由 INV_FULL=1 显式启用，并在 P6 交付记录中留证。
 * 单次动作实测约 16ms（含一笔交易 + 10 条不变量断言）。
 *
 * ★ 生命周期重启（关键设计，勿删）
 * 流程终结（FINALIZED）后，除重启外几乎没有可用动作。若无重启机制，随机序列会在
 * 终态上无限空转：首版实测 512×64 中 78% 的动作发生在已封存的提案上，
 * 真正有价值的动作只有两位数——**只覆盖了一个生命周期**。
 * `spawnLifecycle` 动作会部署新的一组 registry + proposal 并重置追踪，
 * 使 32768 次动作覆盖上千个生命周期。见主战役对 `lifecycleCount` 的断言。
 *
 * 三条硬约束（方案 §16.5 / P1 派生）：
 *   【硬约束 7】固定并打印 seed → engine.resolveSeed + 失败信息含 seed
 *   【硬约束 8】每条不变量具名函数 + 每轮无条件调用 → 本文件断言「检查次数 == 动作次数」
 *   【硬约束 9】动作集覆盖全部入口 + 非法时序/越权 → 本文件断言「各入口均成功过、对抗动作均被触发过」
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { buildProposalInit, buildTimeWindows } from "./helpers/proposal";
import { buildActions } from "./invariant/actions";
import { type RunStats, resolveSeed, runInvariantCampaign } from "./invariant/engine";
import {
    EXPECTED_INVARIANT_COUNT,
    buildInvariants,
    resetSenderEventCheck,
} from "./invariant/invariants";
import { type World, createWorld, refreshView } from "./invariant/world";

describe("P6 · 不变量与状态机随机测试（路径 A）", function () {
    // 随机战役的耗时由规模决定，不用固定超时（避免在慢机器上假失败）
    this.timeout(0);

    const rounds = Number(process.env.INV_ROUNDS ?? 128);
    const actionsPerRound = Number(process.env.INV_ACTIONS ?? 32);

    /** 五个状态变更入口，硬约束 9 */
    const REQUIRED_ENTRIES = [
        "registerVoters",
        "freezeVotersRoot",
        "castVote(诚实)",
        "reveal(诚实)",
        "finalize",
    ];

    /** 必须被触发过的对抗性动作，硬约束 9 */
    const REQUIRED_ADVERSARIAL = [
        "registerVoters(越权)",
        "castVote(已登记地址直投)",
        "castVote(重复 nullifier)",
        "reveal(伪造承诺)",
    ];

    async function deployFixture() {
        const [admin, registrar, relayer, outsider, registeredSigner] = await ethers.getSigners();

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
        const verifierAddr = await verifier.getAddress();

        const now = BigInt(await time.latest());
        const tw = buildTimeWindows(now);

        const R = await ethers.getContractFactory("VoterRegistry", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const registry = await R.deploy(admin.address, tw.registrationEnd);
        await registry.waitForDeployment();

        const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE"));
        await registry.connect(admin).grantRole(REGISTRAR_ROLE, registrar.address);

        const P = await ethers.getContractFactory("ProposalHarness", {
            libraries: { PoseidonT4: pt4Addr },
        });
        const proposal = await P.deploy(
            admin.address,
            buildProposalInit({
                proposalId: 1n,
                registry: await registry.getAddress(),
                verifier: verifierAddr,
                ...tw,
            })
        );
        await proposal.waitForDeployment();

        const scope: bigint = await proposal.SCOPE();

        return {
            registry,
            proposal,
            pt4,
            pt3Addr,
            pt4Addr,
            verifierAddr,
            scope,
            tw,
            admin,
            registrar,
            relayer,
            outsider,
            registeredSigner,
            optionCount: 4,
            maxChoices: 2,
        };
    }

    /**
     * 执行一次完整战役。
     *
     * 注意：World 必须在每个测试内**新建**——`loadFixture` 会复用 fixture 的返回值
     * （同一对象引用），若把可变追踪状态放进去，测试之间会互相污染。
     */
    async function runCampaign(
        f: Awaited<ReturnType<typeof deployFixture>>,
        r: number,
        a: number,
        seed: number
    ): Promise<{ stats: RunStats; world: World }> {
        let world: World;

        world = createWorld({
            registry: f.registry,
            proposal: f.proposal,
            pt4: f.pt4,
            scope: f.scope,
            optionCount: f.optionCount,
            maxChoices: f.maxChoices,
            times: f.tw,
            registeredSigner: f.registeredSigner,
            relayer: f.relayer,
            outsider: f.outsider,
            registrar: f.registrar,
            /**
             * 重启生命周期：部署全新的一组 registry + proposal，并把世界切过去。
             * 只负责「换合约」，追踪状态的重置由动作调用 resetTrackingForNewLifecycle 完成
             * ——这样「重置了什么」集中在一处，便于核对。
             */
            spawn: async () => {
                const now = BigInt(await time.latest());
                const tw = buildTimeWindows(now);

                const R = await ethers.getContractFactory("VoterRegistry", {
                    libraries: { PoseidonT3: f.pt3Addr },
                });
                const registry = await R.deploy(f.admin.address, tw.registrationEnd);
                await registry.waitForDeployment();

                const REGISTRAR_ROLE = ethers.keccak256(
                    ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE")
                );
                await registry.connect(f.admin).grantRole(REGISTRAR_ROLE, f.registrar.address);

                const P = await ethers.getContractFactory("ProposalHarness", {
                    libraries: { PoseidonT4: f.pt4Addr },
                });
                const proposal = await P.deploy(
                    f.admin.address,
                    buildProposalInit({
                        proposalId: BigInt(world.lifecycleCount + 1),
                        registry: await registry.getAddress(),
                        verifier: f.verifierAddr,
                        ...tw,
                    })
                );
                await proposal.waitForDeployment();

                world.registry = registry;
                world.proposal = proposal;
                world.scope = await proposal.SCOPE();
                world.times = tw;
            },
        });

        await refreshView(world);
        resetSenderEventCheck();

        const stats = await runInvariantCampaign({
            seed,
            rounds: r,
            actionsPerRound: a,
            actions: buildActions(world),
            invariants: buildInvariants(world),
            refresh: () => refreshView(world),
        });

        return { stats, world };
    }

    /** 打印战役摘要，便于人工确认覆盖面 */
    function report(stats: RunStats, world?: World): void {
        const names = Object.keys(stats.perAction).sort();
        const pad = Math.max(...names.map((n) => n.length));

        console.log(`\n  ┌─ 动作执行统计 ─────────────────────────────`);
        for (const n of names) {
            const s = stats.perAction[n];
            console.log(
                `  │ ${n.padEnd(pad)}  成功 ${String(s.ok).padStart(5)}  revert ${String(s.revert).padStart(5)}`
            );
        }

        const phaseNames = ["REGISTRATION", "IDLE", "VOTING", "REVEAL", "CLOSED", "FINALIZED"];
        console.log(`  ├─ 阶段分布 ────────────────────────────────`);
        for (const [ph, count] of Object.entries(stats.phaseHits).sort()) {
            console.log(
                `  │ ${(phaseNames[Number(ph)] ?? ph).padEnd(12)} ${String(count).padStart(6)} 次`
            );
        }

        console.log(`  ├─ 不变量检查次数 ──────────────────────────`);
        for (const [id, count] of Object.entries(stats.perInvariant).sort()) {
            console.log(`  │ ${id.padEnd(7)} ${String(count).padStart(6)} 次`);
        }

        if (world) {
            // 用「累计值 + 当前生命周期剩余量」：战役常结束于一次重启之后，
            // 只看当前列表会显示成 0，掩盖真实覆盖量
            const c = world.cumulative;
            console.log(`  ├─ 覆盖度 ──────────────────────────────────`);
            console.log(`  │ 生命周期     ${world.lifecycleCount}`);
            console.log(`  │ 累计登记地址 ${c.registered + world.registeredAddresses.length}`);
            console.log(`  │ 累计上链票据 ${c.casted + world.castedBallots.length}`);
            console.log(`  │ 累计接受揭示 ${c.accepted + world.acceptedBallots.length}`);
            console.log(`  │ 累计作废揭示 ${c.rejected + world.rejectedCommitments.length}`);
        }
        console.log(`  └────────────────────────────────────────────\n`);
    }

    /** 构造一个仅用于静态检查的 World（不执行任何动作） */
    function staticWorld(f: Awaited<ReturnType<typeof deployFixture>>): World {
        return createWorld({
            registry: f.registry,
            proposal: f.proposal,
            pt4: f.pt4,
            scope: f.scope,
            optionCount: f.optionCount,
            maxChoices: f.maxChoices,
            times: f.tw,
            registeredSigner: f.registeredSigner,
            relayer: f.relayer,
            outsider: f.outsider,
            registrar: f.registrar,
            spawn: async () => {},
        });
    }

    // ============================================================
    // 1. 自检：清单完整性与调度正确性
    // ============================================================

    describe("引擎自检（防止守卫静默失效）", function () {
        it("不变量清单必须完整：10 条且 id 连续", async function () {
            const f = await loadFixture(deployFixture);
            const invs = buildInvariants(staticWorld(f));

            expect(invs.length, "不变量条数被改动").to.equal(EXPECTED_INVARIANT_COUNT);
            invs.forEach((inv, i) => {
                expect(inv.id, `第 ${i + 1} 条不变量编号不连续`).to.equal(`INV-${i + 1}`);
                expect(inv.name.length, `${inv.id} 缺少名称`).to.be.greaterThan(0);
            });
        });

        it("动作集必须覆盖全部状态变更入口，且含对抗性动作", async function () {
            const f = await loadFixture(deployFixture);
            const actions = buildActions(staticWorld(f));
            const names = actions.map((a) => a.name);

            // 【硬约束 9】五个状态变更入口
            for (const entry of REQUIRED_ENTRIES) {
                expect(names, `动作集缺少入口 ${entry}`).to.include(entry);
            }

            // 生命周期重启动作（缺了它覆盖度会崩塌为单次流程，见文件头说明）
            expect(names, "动作集缺少生命周期重启动作").to.include("spawnLifecycle(重启提案)");

            // 【硬约束 9】非法时序 + 越权动作
            const adversarial = actions.filter((a) => a.kind === "mustRevert");
            expect(adversarial.length, "对抗性动作过少，覆盖不足").to.be.greaterThanOrEqual(8);
            for (const entry of [
                ...REQUIRED_ADVERSARIAL,
                "reveal(时序非法)",
                "finalize(时序非法)",
            ]) {
                expect(names, `动作集缺少对抗性动作 ${entry}`).to.include(entry);
            }

            // 每个动作都必须有名称与权重函数
            for (const a of actions) {
                expect(a.name.length, "动作缺少名称").to.be.greaterThan(0);
                expect(typeof a.weight(), "weight() 必须返回数字").to.equal("number");
            }
        });
    });

    // ============================================================
    // 2. 主战役
    // ============================================================

    describe("随机战役", function () {
        it(`默认规模 ${rounds}×${actionsPerRound}：INV-1~INV-10 全程无破坏`, async function () {
            const seed = resolveSeed();
            const f = await loadFixture(deployFixture);

            const { stats, world } = await runCampaign(f, rounds, actionsPerRound, seed);
            report(stats, world);

            // 【硬约束 8】每条不变量被检查的次数必须等于动作总数
            // —— 若不等，说明调度逻辑被改坏了（例如有人加了 early-return）
            for (const inv of buildInvariants(staticWorld(f))) {
                expect(
                    stats.perInvariant[inv.id],
                    `${inv.id} 的检查次数应等于动作总数（硬约束 8：每轮无条件调用）`
                ).to.equal(stats.totalActions);
            }

            // 【硬约束 9】每个阶段都必须被访问到（否则流程没被穿越）
            for (let ph = 0; ph <= 5; ph++) {
                expect(
                    stats.phaseHits[ph] ?? 0,
                    `阶段 ${ph} 从未被访问 —— 随机序列未穿越完整流程`
                ).to.be.greaterThan(0);
            }

            // 【硬约束 9】五个入口都必须**成功执行过**
            for (const entry of REQUIRED_ENTRIES) {
                expect(
                    stats.perAction[entry]?.ok ?? 0,
                    `入口 ${entry} 从未成功执行 —— 该路径未被覆盖`
                ).to.be.greaterThan(0);
            }

            // 【硬约束 9】对抗性动作必须被触发过（revert 即证明防护生效）
            for (const entry of REQUIRED_ADVERSARIAL) {
                expect(
                    stats.perAction[entry]?.revert ?? 0,
                    `对抗性动作 ${entry} 从未被触发 —— 该防护未被验证`
                ).to.be.greaterThan(0);
            }

            // ★ 覆盖度：必须真的走完了多个提案生命周期
            // 没有这条断言，「跑了很多次」的假象无法被识破
            expect(
                world.lifecycleCount,
                "只覆盖了一个生命周期 —— 随机序列在终态上空转，覆盖度是虚的"
            ).to.be.greaterThan(3);
        });

        it("相同 seed 必须产生完全相同的动作序列（可复现）", async function () {
            const seed = 0xabcdef;
            const f1 = await loadFixture(deployFixture);
            const a = await runCampaign(f1, 32, 8, seed);

            const f2 = await loadFixture(deployFixture);
            const b = await runCampaign(f2, 32, 8, seed);

            expect(b.stats.perAction, "相同 seed 的动作统计必须一致").to.deep.equal(
                a.stats.perAction
            );
            expect(b.stats.phaseHits, "相同 seed 的阶段分布必须一致").to.deep.equal(
                a.stats.phaseHits
            );
        });

        it("不同 seed 必须产生不同的序列（证明随机源真的在起作用）", async function () {
            const f1 = await loadFixture(deployFixture);
            const a = await runCampaign(f1, 32, 8, 0x1111);

            const f2 = await loadFixture(deployFixture);
            const b = await runCampaign(f2, 32, 8, 0x2222);

            expect(
                b.stats.perAction,
                "不同 seed 竟然产生了相同序列 —— 随机源可能失效"
            ).to.not.deep.equal(a.stats.perAction);
        });
    });

    // ============================================================
    // 3. DoD 完整规模（显式启用）
    // ============================================================

    describe("DoD 完整规模", function () {
        it("512×64 战役（需 INV_FULL=1 启用）", async function () {
            if (process.env.INV_FULL !== "1") {
                console.log("        · 已跳过：设置 INV_FULL=1 运行完整 512×64 战役");
                this.skip();
            }

            const seed = resolveSeed();
            const f = await loadFixture(deployFixture);
            const { stats, world } = await runCampaign(f, 512, 64, seed);
            report(stats, world);

            expect(stats.totalActions).to.equal(512 * 64);

            // 覆盖度断言在完整规模下同样适用
            expect(world.lifecycleCount, "完整规模下仍未覆盖多个生命周期").to.be.greaterThan(10);
            for (const entry of REQUIRED_ENTRIES) {
                expect(
                    stats.perAction[entry]?.ok ?? 0,
                    `入口 ${entry} 在完整规模下从未成功执行`
                ).to.be.greaterThan(0);
            }
        });
    });
});
