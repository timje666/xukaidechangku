/**
 * P6b · 畸形 calldata 模糊测试
 *
 * 补上 P6 主引擎的第二个能力缺口：主引擎在 ethers 层构造调用，输入空间受
 * ABI 编码器约束。本文件通过**直接发送原始 calldata**（绕过 ABI 编码器）
 * 覆盖 ABI 之外的输入空间。
 *
 * 与 `forge invariant` / Echidna 的差距：
 *   · 它们的变异是自动生成的；本文件需要**人工设计变异算子**（见 MUTATORS 的 intent）
 *   · 因此覆盖面上限取决于算子质量，而非自动化程度
 *   但「无法覆盖畸形输入」这个判断**不成立**——绕过 ABI 编码器即可。
 *
 * ## 快照管理（这里有个不明显的坑）
 *
 * 本文件需要在同一测试内**比较合法调用与变异调用的行为**，因此必须能回滚状态。
 * 由此带来两个约束：
 *   1. **不能用 `loadFixture`**：它自身的快照跟踪会与手动 `evm_revert` 冲突
 *   2. **不能每个用例都重新部署**：`evm_revert` 会同时回滚 deployer 的 nonce，
 *      导致下一次 `deploy` 落在**同一个地址**上——而那个地址上的旧合约状态也被回滚了，
 *      于是「新部署」实际复用旧数据，表现为莫名的 `CommitmentAlreadyUsed`。
 *      （这是实测踩到的：23 个用例全部因此失败）
 *
 * 正确做法：`before` 里部署一次并冻结时间窗，`beforeEach` 回滚到该基线。
 * `evm_revert` 会消耗快照，故回滚后必须立即重新创建。
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { buildProposalInit, buildTimeWindows } from "./helpers/proposal";
import { MUTATORS, evmRevert, evmSnapshot, rawCall, snapshotState } from "./invariant/calldata-fuzz";
import { mulberry32 } from "./invariant/engine";
import { SNARK_SCALAR_FIELD, toHex32 } from "./invariant/world";

describe("P6b · 畸形 calldata 模糊测试（补足字节码层输入空间）", function () {
    this.timeout(0);

    /** 记录触发 Panic 的用例（Panic 表示存在未处理的边界） */
    const panics: string[] = [];

    let base: any;
    let baseSnap: string;

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

        // 确定性地址与承诺（不用 Wallet.createRandom，避免破坏可复现性）
        const voters = [0, 1, 2].map((i) =>
            ethers.getAddress("0x" + ethers.id(`p6b-voter-${i}`).slice(26))
        );
        const commits = [0, 1, 2].map((i) => {
            const v = BigInt(ethers.id(`p6b-commit-${i}`)) % SNARK_SCALAR_FIELD;
            return v === 0n ? 1n : v;
        });
        await registry.connect(registrar).registerVoters(voters, commits);

        // ⚠️ 顺序有约束：Proposal 构造时会校验 `registrationEnd - now >= MIN_REGISTRATION_WINDOW`，
        // 因此**必须在推进时间之前**部署（推进后差值归零 → InvalidTimeWindow）。
        // 这在生产部署流程中同样成立：提案须在登记期内创建。
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

        // 登记期结束后固化名册根
        await time.increaseTo(tw.registrationEnd);
        await registry.freezeVotersRoot();
        const root: bigint = await registry.frozenRoot();

        return {
            registry,
            proposal,
            pt4,
            root,
            scope: (await proposal.SCOPE()) as bigint,
            tw,
            admin,
            registrar,
            relayer,
        };
    }

    function makeProof(root: bigint, scope: bigint, nullifier: bigint, message: bigint) {
        return {
            merkleTreeDepth: 20n,
            merkleTreeRoot: root,
            nullifier,
            message,
            scope,
            points: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n],
        };
    }

    /** 推进到投票期，返回**合法**的 castVote calldata */
    async function prepareCastVote(): Promise<string> {
        await time.increaseTo(base.tw.votingStart + 10n);
        const message: bigint = await base.pt4.hash([1n, 1n, base.scope]);
        return base.proposal.interface.encodeFunctionData("castVote", [
            makeProof(base.root, base.scope, 12345n, message),
        ]);
    }

    /** 推进到揭示期（先投一票），返回**合法**的 reveal calldata */
    async function prepareReveal(): Promise<string> {
        await time.increaseTo(base.tw.votingStart + 10n);

        const mask = 1;
        const salt = 777n;
        const commitment: bigint = await base.pt4.hash([BigInt(mask), salt, base.scope]);
        await base.proposal
            .connect(base.relayer)
            .castVote(makeProof(base.root, base.scope, 4242n, commitment));

        await time.increaseTo(base.tw.votingEnd + 10n);
        return base.proposal.interface.encodeFunctionData("reveal", [
            [{ ballotCommitment: toHex32(commitment), ballotMask: mask, salt }],
        ]);
    }

    const PREPARE: Record<string, () => Promise<string>> = {
        castVote: prepareCastVote,
        reveal: prepareReveal,
    };

    // 只在开始时部署一次；此后每次用例通过快照回到该基线
    before(async function () {
        base = await deployFixture();
        baseSnap = await evmSnapshot();
    });

    beforeEach(async function () {
        await evmRevert(baseSnap);
        // evm_revert 消耗快照，必须立即重建，否则下一次回滚会失败
        baseSnap = await evmSnapshot();
    });

    for (const funcName of ["castVote", "reveal"]) {
        describe(`${funcName} 的畸形输入`, function () {
            const applicable = MUTATORS.filter(
                (m) => m.appliesTo.includes("*") || m.appliesTo.includes(funcName)
            );

            for (const m of applicable) {
                it(`${m.name}`, async function () {
                    const to = await base.proposal.getAddress();
                    const legal = await PREPARE[funcName]();

                    // 确定性变异（与主引擎同一 RNG，保证失败可复现）
                    const rng = mulberry32(0x5eed ^ m.name.length);
                    const mutated = m.apply(legal, rng);

                    // --- 基线：合法调用 ---
                    let snap = await evmSnapshot();
                    const r1 = await rawCall(base.relayer, to, legal);
                    const s1 = await snapshotState(base.proposal);
                    await evmRevert(snap);

                    // --- 实验：变异调用 ---
                    snap = await evmSnapshot();
                    const r2 = await rawCall(base.relayer, to, mutated);
                    const s2 = await snapshotState(base.proposal);
                    const finalizedAfter = await base.proposal.finalized();
                    const nullifiersAfter = BigInt(await base.proposal.nullifierCount());
                    await evmRevert(snap);

                    // 基线必须成立，否则该用例没有比较意义
                    expect(
                        r1.ok,
                        `基线（合法 calldata）本应成功，却失败了：${r1.reason}`
                    ).to.equal(true);

                    switch (m.expectation) {
                        case "mustRevert":
                            expect(
                                r2.ok,
                                `【${m.name}】应被拒绝却成功执行。\n意图：${m.intent}`
                            ).to.equal(false);
                            break;

                        case "mustNotChangeBehavior":
                            expect(
                                r2.ok,
                                `【${m.name}】行为与合法调用不一致（合法=成功，变异=失败）。\n` +
                                    `意图：${m.intent}\n变异后失败原因：${r2.reason}`
                            ).to.equal(r1.ok);
                            expect(
                                s2,
                                `【${m.name}】状态与合法调用不一致。\n意图：${m.intent}`
                            ).to.equal(s1);
                            break;

                        case "maySucceed":
                            if (r2.ok) {
                                // 成功是允许的（可能恰好命中合法值），但状态必须自洽：
                                // 单次调用最多新增一张票，且不得意外封存
                                const n1 = BigInt(s1.split("|")[0]);
                                expect(
                                    nullifiersAfter - n1,
                                    `【${m.name}】成功后票据增量异常。\n意图：${m.intent}`
                                ).to.be.lessThanOrEqual(1n);
                                expect(
                                    finalizedAfter,
                                    `【${m.name}】不得意外触发封存。\n意图：${m.intent}`
                                ).to.equal(false);
                            }
                            break;
                    }

                    // 失败时不应出现 Panic（Panic 表示存在未处理的边界，
                    // 前端无法把 panic code 映射为可读文案；见 P3 修过的同类问题）
                    if (!r2.ok && /panic code/i.test(r2.reason ?? "")) {
                        panics.push(`${funcName} / ${m.name} → ${r2.reason}`);
                    }
                });
            }
        });
    }

    it("汇总：畸形输入不得触发 Panic（未处理的边界）", function () {
        expect(
            panics,
            `以下畸形输入触发了 Panic，应按 P3 的做法改为具名 custom error：\n  ${panics.join("\n  ")}`
        ).to.deep.equal([]);
    });
});
