import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { buildProposalInit, buildTimeWindows } from "./helpers/proposal";

/**
 * P4 单元测试 —— Semaphore 集成（`castVote` + ZK 证明校验）
 *
 * 测试策略说明（重要）：
 *   本机**无法生成真实 Groth16 证明**——电路产物（.wasm/.zkey，数 MB）不在 npm 包内
 *   （zk-kit 的 artifacts 包仅 48 KB），需从 snark-artifacts CDN 下载，该域名不可达。
 *
 *   因此测试分两路，各自覆盖不同风险：
 *
 *   【真实验证器】用于全部**拒绝路径**：伪造/畸形证明必须被拒。
 *     这验证了与官方 SemaphoreVerifier 的接线正确。
 *
 *   【测试替身 + strictMode】用于**成功路径**与**公开信号组成**：
 *     替身按上游公式自行重算 `_hash(message)` / `_hash(scope)` 并逐项比对，
 *     若 Proposal 漏了哈希或调换了顺序，替身返回 false，测试即失败。
 *     这把「本机无法端到端验证」的约束变成了可断言的运行时事实。
 *
 *   未被覆盖的残余风险：真实证明的端到端接受（见 P4 交付记录的遗留项 L4-1）。
 */
describe("P4 · Semaphore 集成", function () {
    const HOUR = 3600n;
    const SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617n;

    async function deployFixture() {
        const [admin, registrar, alice] = await ethers.getSigners();

        const PT3 = await ethers.getContractFactory("PoseidonT3");
        const pt3 = await PT3.deploy();
        await pt3.waitForDeployment();

        const PT4 = await ethers.getContractFactory("PoseidonT4");
        const pt4 = await PT4.deploy();
        await pt4.waitForDeployment();

        const pt3Addr = await pt3.getAddress();
        const pt4Addr = await pt4.getAddress();

        const Real = await ethers.getContractFactory("SemaphoreVerifier");
        const realVerifier = await Real.deploy();
        await realVerifier.waitForDeployment();

        const Mock = await ethers.getContractFactory("MockVerifier");
        const mockVerifier = await Mock.deploy();
        await mockVerifier.waitForDeployment();

        const R = await ethers.getContractFactory("VoterRegistry", {
            libraries: { PoseidonT3: pt3Addr },
        });

        const now = BigInt(await time.latest());
        const tw = buildTimeWindows(now);

        const registry = await R.deploy(admin.address, tw.registrationEnd);
        await registry.waitForDeployment();

        const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE"));
        await registry.connect(admin).grantRole(REGISTRAR_ROLE, registrar.address);

        // 注意：`castVote` 会校验 `!isRegistered(msg.sender)`（阻断登记地址直投）。
        // 测试 signer 均不在名册中（名册登记的是随机地址），故可正常提交。
        const P = await ethers.getContractFactory("ProposalHarness", {
            libraries: { PoseidonT4: pt4Addr },
        });

        const baseInit = {
            registry: await registry.getAddress(),
            ...tw,
        };

        const pReal = await P.deploy(
            admin.address,
            buildProposalInit({
                ...baseInit,
                proposalId: 1n,
                verifier: await realVerifier.getAddress(),
            })
        );
        await pReal.waitForDeployment();

        const pMock = await P.deploy(
            admin.address,
            buildProposalInit({
                ...baseInit,
                proposalId: 2n,
                verifier: await mockVerifier.getAddress(),
            })
        );
        await pMock.waitForDeployment();

        return {
            registry,
            realVerifier,
            mockVerifier,
            pReal,
            pMock,
            pt4Addr,
            admin,
            registrar,
            alice,
            now,
            registrationEnd: tw.registrationEnd,
            votingStart: tw.votingStart,
            votingEnd: tw.votingEnd,
            revealEnd: tw.revealEnd,
        };
    }

    /** 登记 3 个选民并冻结名册根，返回冻结后的根 */
    async function setupRoster(f: any) {
        const voters = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().address);
        const commitments = voters.map((_, i) => commitmentFor(100 + i));
        await f.registry.connect(f.registrar).registerVoters(voters, commitments);
        await time.increaseTo(f.registrationEnd);
        await f.registry.freezeVotersRoot();
        return { voters, commitments, root: await f.registry.frozenRoot() };
    }

    function commitmentFor(i: number | string): bigint {
        return BigInt(ethers.keccak256(ethers.toUtf8Bytes(`cv-commit-${i}`))) % SNARK_SCALAR_FIELD;
    }

    /** 构造一个结构完整但内容任意的证明 */
    function makeProof(o: Record<string, unknown> = {}) {
        return {
            merkleTreeDepth: 20n,
            merkleTreeRoot: 0n,
            nullifier: 0n,
            message: 0n,
            scope: 0n,
            points: Array.from({ length: 8 }, (_, i) => BigInt(i + 1)),
            ...o,
        };
    }

    /** 与 Semaphore 官方一致的标量哈希 */
    function referenceHash(x: bigint): bigint {
        return BigInt(ethers.keccak256(ethers.solidityPacked(["uint256"], [x]))) >> 8n;
    }

    // ============================================================
    // 1. _hash 公式（与上游一致性）
    // ============================================================
    describe("★ _hash 公式必须与 Semaphore 上游一致", function () {
        it("hashScalar(x) === keccak256(abi.encodePacked(x)) >> 8", async function () {
            const { pReal } = await loadFixture(deployFixture);
            for (const x of [0n, 1n, 12345n, SNARK_SCALAR_FIELD - 1n, 2n ** 200n]) {
                expect(await pReal.hashScalar(x)).to.equal(referenceHash(x));
            }
        });

        it("与验证器替身内的参考实现一致（交叉验证）", async function () {
            const { pReal, mockVerifier } = await loadFixture(deployFixture);
            for (const x of [7n, 99999n, SNARK_SCALAR_FIELD - 1n]) {
                expect(await pReal.hashScalar(x)).to.equal(await mockVerifier.referenceHash(x));
            }
        });

        it("结果落在 SNARK 标量域内", async function () {
            const { pReal } = await loadFixture(deployFixture);
            const h = await pReal.hashScalar(SNARK_SCALAR_FIELD - 1n);
            expect(h).to.be.lessThan(SNARK_SCALAR_FIELD);
        });
    });

    // ============================================================
    // 2. 时窗与前置检查（在验证之前）
    // ============================================================
    describe("前置检查与时窗", function () {
        it("投票期前 castVote 被拒", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await expect(
                f.pReal.castVote(makeProof({ merkleTreeRoot: root, scope: await f.pReal.SCOPE() }))
            ).to.be.revertedWithCustomError(f.pReal, "VotingNotOpen");
        });

        it("投票期结束后 castVote 被拒", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingEnd);
            await expect(
                f.pReal.castVote(makeProof({ merkleTreeRoot: root, scope: await f.pReal.SCOPE() }))
            ).to.be.revertedWithCustomError(f.pReal, "VotingClosed");
        });

        it("★ 名册未冻结时被拒（RootNotFrozen），而不是用未冻结的根去验证明", async function () {
            const f = await loadFixture(deployFixture);
            const voters = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().address);
            const commitments = voters.map((_, i) => commitmentFor(200 + i));
            await f.registry.connect(f.registrar).registerVoters(voters, commitments);
            // 故意不冻结
            await time.increaseTo(f.votingStart + 10n);

            // 该错误由名册合约的 requireFrozenRoot() 抛出，
            // 因此必须针对 registry 的 ABI 断言，而非 Proposal
            await expect(
                f.pReal.castVote(makeProof({ merkleTreeRoot: 123n, scope: await f.pReal.SCOPE() }))
            ).to.be.revertedWithCustomError(f.registry, "RootNotFrozen");
        });

        it("Merkle 根与冻结根不符时被拒（RootMismatch）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            await expect(
                f.pReal.castVote(makeProof({ merkleTreeRoot: root + 1n, scope: await f.pReal.SCOPE() }))
            ).to.be.revertedWithCustomError(f.pReal, "RootMismatch");
        });

        it("★ scope 不匹配时被拒（InvalidScope）—— 跨提案重放防护", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const scopeA = await f.pReal.SCOPE();
            const scopeB = await f.pMock.SCOPE();
            expect(scopeA).to.not.equal(scopeB); // 两个提案的 scope 必然不同

            // 拿 A 的 scope 去投 B
            await expect(
                f.pMock.castVote(makeProof({ merkleTreeRoot: root, scope: scopeA }))
            ).to.be.revertedWithCustomError(f.pMock, "InvalidScope");

            // 拿 B 的 scope 去投 A
            await expect(
                f.pReal.castVote(makeProof({ merkleTreeRoot: root, scope: scopeB }))
            ).to.be.revertedWithCustomError(f.pReal, "InvalidScope");
        });
    });

    // ============================================================
    // 3. ★ 真实验证器 · 拒绝伪造证明
    // ============================================================
    describe("★ 真实验证器 · 伪造证明必须被拒", function () {
        it("全零/小整数 points 的伪造证明被拒（InvalidProof）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            await expect(
                f.pReal.castVote(makeProof({ merkleTreeRoot: root, scope: await f.pReal.SCOPE(), nullifier: 1n }))
            ).to.be.revertedWithCustomError(f.pReal, "InvalidProof");
        });

        it("随机大整数 points 的伪造证明被拒（验证器内部 revert 亦被收敛为 InvalidProof）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const junk = Array.from({ length: 8 }, (_, i) => SNARK_SCALAR_FIELD - BigInt(i + 1));
            await expect(
                f.pReal.castVote(
                    makeProof({
                        merkleTreeRoot: root,
                        scope: await f.pReal.SCOPE(),
                        nullifier: 2n,
                        points: junk,
                    })
                )
            ).to.be.revertedWithCustomError(f.pReal, "InvalidProof");
        });

        it("★ F-05：验证失败不产生任何状态副作用", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const nullifier = 424242n;
            const message = commitmentFor(999);

            await expect(
                f.pReal.castVote(
                    makeProof({ merkleTreeRoot: root, scope: await f.pReal.SCOPE(), nullifier, message })
                )
            ).to.be.revertedWithCustomError(f.pReal, "InvalidProof");

            // 关键断言：伪造的 nullifier 绝不能被写入
            expect(await f.pReal.isNullifierUsed(nullifier)).to.equal(false);
            expect(await f.pReal.isCommitmentCast(ethers.zeroPadValue(ethers.toBeHex(message), 32))).to.equal(
                false
            );
            expect(await f.pReal.nullifierCount()).to.equal(0n);
        });
    });

    // ============================================================
    // 4. 成功路径（测试替身）
    // ============================================================
    describe("成功路径（测试替身）", function () {
        it("验证通过后正常记录选票，计数与事件正确", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.pMock.SCOPE();
            const nullifier = 11n;
            const message = commitmentFor(11);

            await expect(
                f.pMock.castVote(makeProof({ merkleTreeRoot: root, scope, nullifier, message }))
            )
                .to.emit(f.pMock, "BallotCommitted")
                .withArgs(2n, nullifier, ethers.zeroPadValue(ethers.toBeHex(message), 32), 0n);

            expect(await f.pMock.nullifierCount()).to.equal(1n);
            expect(await f.pMock.isNullifierUsed(nullifier)).to.equal(true);
        });

        it("同一 nullifier 二次投票被拒（AlreadyVoted）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);
            const scope = await f.pMock.SCOPE();

            await f.pMock.castVote(
                makeProof({ merkleTreeRoot: root, scope, nullifier: 21n, message: commitmentFor(21) })
            );
            await expect(
                f.pMock.castVote(
                    makeProof({ merkleTreeRoot: root, scope, nullifier: 21n, message: commitmentFor(22) })
                )
            ).to.be.revertedWithCustomError(f.pMock, "AlreadyVoted");
        });

        it("同一 message 二次投票被拒（CommitmentAlreadyCast）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);
            const scope = await f.pMock.SCOPE();
            const message = commitmentFor(31);

            await f.pMock.castVote(
                makeProof({ merkleTreeRoot: root, scope, nullifier: 31n, message })
            );
            await expect(
                f.pMock.castVote(makeProof({ merkleTreeRoot: root, scope, nullifier: 32n, message }))
            ).to.be.revertedWithCustomError(f.pMock, "CommitmentAlreadyCast");
        });

        it("merkleTreeDepth = 0 时替身返回 false → InvalidProof", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            await expect(
                f.pMock.castVote(
                    makeProof({
                        merkleTreeDepth: 0n,
                        merkleTreeRoot: root,
                        scope: await f.pMock.SCOPE(),
                        nullifier: 41n,
                    })
                )
            ).to.be.revertedWithCustomError(f.pMock, "InvalidProof");
        });

        it("替身改为一律拒绝时 → InvalidProof", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);
            await f.mockVerifier.setAlwaysAccept(false);

            await expect(
                f.pMock.castVote(
                    makeProof({
                        merkleTreeRoot: root,
                        scope: await f.pMock.SCOPE(),
                        nullifier: 51n,
                        message: commitmentFor(51),
                    })
                )
            ).to.be.revertedWithCustomError(f.pMock, "InvalidProof");
        });

        it("★ 验证器直接 revert 时，必须被收敛为 InvalidProof（catch 安全网）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            // 真实 SemaphoreVerifier 对畸形点等输入可能直接 revert 而非返回 false。
            // 若 Proposal 未用 try/catch 收敛，用户将拿到不可读的底层错误
            // （例如 ecPairing 预编译失败），且前端无法映射为可读文案。
            await f.mockVerifier.setRevertMode(true);

            const nullifier = 52n;
            await expect(
                f.pMock.castVote(
                    makeProof({
                        merkleTreeRoot: root,
                        scope: await f.pMock.SCOPE(),
                        nullifier,
                        message: commitmentFor(52),
                    })
                )
            ).to.be.revertedWithCustomError(f.pMock, "InvalidProof");

            // 收敛后同样不得产生任何状态副作用
            expect(await f.pMock.isNullifierUsed(nullifier)).to.equal(false);
        });

        it("投票成功后进入揭示期可正常揭示（端到端状态贯通）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.pMock.SCOPE();
            const salt = 777n;
            const mask = 0b0010;

            // 用**链上** PoseidonT4 计算选票承诺，与 P3 的公式保持一致：
            // ballotCommitment = Poseidon4([mask, salt, scope])
            const PT4 = await ethers.getContractFactory("PoseidonT4");
            const pt4 = await PT4.deploy();
            await pt4.waitForDeployment();
            const committed = BigInt(await pt4.hash([BigInt(mask), salt, scope]));

            await f.pMock.castVote(
                makeProof({ merkleTreeRoot: root, scope, nullifier: 61n, message: committed })
            );
            expect(await f.pMock.nullifierCount()).to.equal(1n);

            await time.increaseTo(f.votingEnd + 10n);
            await f.pMock.reveal([
                {
                    ballotCommitment: ethers.zeroPadValue(ethers.toBeHex(committed), 32),
                    ballotMask: mask,
                    salt,
                },
            ]);

            expect(await f.pMock.revealedCount()).to.equal(1n);
            expect(await f.pMock.rejectedCount()).to.equal(0n);
            expect(await f.pMock.totalMarks()).to.equal(1n);
        });
    });

    // ============================================================
    // 5. ★ 公开信号的组成（strictMode 交叉验证）
    // ============================================================
    describe("★ 公开信号组成与上游一致", function () {
        it("root / nullifier / hash(message) / hash(scope) 四项均正确传递", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.pMock.SCOPE();
            const nullifier = 71n;
            const message = commitmentFor(71);

            // 启用严格模式：替身会按上游公式重算后两项并逐项比对
            await f.mockVerifier.expectSignals(message, scope, root, nullifier);

            await expect(
                f.pMock.castVote(makeProof({ merkleTreeRoot: root, scope, nullifier, message }))
            ).to.not.be.reverted;

            expect(await f.pMock.nullifierCount()).to.equal(1n);
        });

        it("自检：strictMode 确实在起作用（期望值故意写错时必须失败）", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.pMock.SCOPE();
            const nullifier = 81n;
            const message = commitmentFor(81);

            // 期望的 message 与实参不同 → 替身应返回 false → InvalidProof
            await f.mockVerifier.expectSignals(message + 1n, scope, root, nullifier);

            await expect(
                f.pMock.castVote(makeProof({ merkleTreeRoot: root, scope, nullifier, message }))
            ).to.be.revertedWithCustomError(f.pMock, "InvalidProof");
        });

        it("自检：scope 传原值（不哈希）也必须失败", async function () {
            const f = await loadFixture(deployFixture);
            const { root } = await setupRoster(f);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.pMock.SCOPE();
            const nullifier = 91n;
            const message = commitmentFor(91);

            // 期望值设为「原值」而非哈希后的值 → 若 Proposal 误传原值就会「通过」，
            // 从而暴露出问题。此处验证替身用的是哈希后的值。
            await f.mockVerifier.expectSignals(message, scope, root, nullifier);
            const after = await f.mockVerifier.referenceHash(scope);
            expect(after).to.not.equal(scope); // 哈希确实改变了值

            await expect(
                f.pMock.castVote(makeProof({ merkleTreeRoot: root, scope, nullifier, message }))
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // 6. 部署参数校验
    // ============================================================
    describe("部署参数校验", function () {
        it("verifier 为零地址应被拒", async function () {
            const f = await loadFixture(deployFixture);
            const P = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: f.pt4Addr },
            });
            await expect(
                P.deploy(
                    f.admin.address,
                    buildProposalInit({
                        proposalId: 9n,
                        registry: await f.registry.getAddress(),
                        verifier: ethers.ZeroAddress,
                        now: f.now,
                        registrationEnd: f.registrationEnd,
                        votingStart: f.votingStart,
                        votingEnd: f.votingEnd,
                        revealEnd: f.revealEnd,
                    })
                )
            ).to.be.revertedWithCustomError(P, "ZeroAddress");
        });

        it("VERIFIER 不可变参数被正确保存", async function () {
            const f = await loadFixture(deployFixture);
            expect(await f.pReal.VERIFIER()).to.equal(await f.realVerifier.getAddress());
            expect(await f.pMock.VERIFIER()).to.equal(await f.mockVerifier.getAddress());
        });

        it("编译锚点确保 SemaphoreVerifier 的 artifact 可用", async function () {
            // 若无人 import 具体实现，Hardhat 不产出 artifact，
            // 部署脚本与测试都会以 HH700 失败。本断言把该前置条件固定下来。
            const C = await ethers.getContractFactory("CompilationAnchors");
            const c = await C.deploy();
            await c.waitForDeployment();
            expect(await c.verifierContractName()).to.equal("SemaphoreVerifier");

            const V = await ethers.getContractFactory("SemaphoreVerifier");
            const v = await V.deploy();
            await v.waitForDeployment();
            expect(await v.getAddress()).to.be.properAddress;
        });
    });
});
