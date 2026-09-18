import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * P3 单元测试 —— Proposal 四阶段状态机
 *
 * 重点覆盖：
 *   - 全部六个阶段的推进与边界（INV-5 阶段单调）
 *   - ★ F-02 关键防护：未上链的承诺不可揭示（否则可凭空造票）
 *   - 时窗守卫一律直接比较时间戳，不使用 phase()（F-01 同类风险）
 *   - 硬约束 3：getCounts / getResultHash 在封存前必须 revert
 *   - ★ 域分隔：同一 (mask, salt) 在不同提案中产生不同承诺（防止跨提案关联）
 */
describe("P3 · Proposal 状态机", function () {
    const HOUR = 3600n;

    async function deployFixture() {
        const [admin, alice, bob, carol] = await ethers.getSigners();

        const PT4 = await ethers.getContractFactory("PoseidonT4");
        const pt4 = await PT4.deploy();
        await pt4.waitForDeployment();
        const pt4Addr = await pt4.getAddress();

        const now = BigInt(await time.latest());
        // 注意：部署交易会使 block.timestamp 前进，故每段窗口都必须比下限留出余量，
        // 否则「registrationEnd - now_」会恰好等于下限而差 1 秒被判非法。
        const init = {
            proposalId: 1n,
            registry: alice.address,
            metadataCid: ethers.id("chainvote-meta"),
            registrationEnd: now + 2n * HOUR,
            votingStart: now + 4n * HOUR,
            votingEnd: now + 8n * HOUR,
            revealEnd: now + 8n * HOUR + 48n * HOUR,
            optionCount: 4,
            maxChoices: 2,
        };

        const H = await ethers.getContractFactory("ProposalHarness", {
            libraries: { PoseidonT4: pt4Addr },
        });
        const h = await H.deploy(admin.address, init);
        await h.waitForDeployment();

        const scope = await h.SCOPE();

        return { h, pt4, pt4Addr, admin, alice, bob, carol, init, now, scope };
    }

    /** 用链上 PoseidonT4 作为校验和预言机，计算选票承诺 */
    async function makeCommitment(pt4: any, scope: bigint, mask: number, salt: bigint) {
        const h = await pt4.hash([BigInt(mask), salt, scope]);
        return ethers.toBeHex(h, 32) as string;
    }

    // ============================================================
    // 1. 部署与配置校验
    // ============================================================
    describe("部署与配置校验", function () {
        it("合法配置可部署，不可变参数正确", async function () {
            const { h, init, scope } = await loadFixture(deployFixture);
            expect(await h.PROPOSAL_ID()).to.equal(1n);
            expect(await h.OPTION_COUNT()).to.equal(4n);
            expect(await h.MAX_CHOICES()).to.equal(2n);
            expect(await h.REGISTRATION_END()).to.equal(init.registrationEnd);
            expect(await h.VOTING_START()).to.equal(init.votingStart);
            expect(await h.VOTING_END()).to.equal(init.votingEnd);
            expect(await h.REVEAL_END()).to.equal(init.revealEnd);
            expect(scope).to.not.equal(0n);
        });

        it("registry 为零地址应被拒", async function () {
            const { init, pt4Addr } = await loadFixture(deployFixture);
            const [admin] = await ethers.getSigners();
            const H = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: pt4Addr },
            });
            await expect(
                H.deploy(admin.address, { ...init, registry: ethers.ZeroAddress })
            ).to.be.revertedWithCustomError(H, "ZeroAddress");
        });

        it("选项配置越界应被拒（optionCount / maxChoices）", async function () {
            const { init, pt4Addr } = await loadFixture(deployFixture);
            const [admin] = await ethers.getSigners();
            const H = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: pt4Addr },
            });

            // optionCount = 1 低于下限 2
            await expect(
                H.deploy(admin.address, { ...init, optionCount: 1, maxChoices: 1 })
            ).to.be.revertedWithCustomError(H, "InvalidOptionCount");
            // maxChoices = 9 超过上限 8
            await expect(
                H.deploy(admin.address, { ...init, optionCount: 16, maxChoices: 9 })
            ).to.be.revertedWithCustomError(H, "InvalidOptionCount");
        });

        it("时间窗倒序或越界应被拒", async function () {
            const { init, pt4Addr } = await loadFixture(deployFixture);
            const [admin] = await ethers.getSigners();
            const H = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: pt4Addr },
            });

            // registrationEnd 与 votingStart 相等（非严格递增）
            await expect(
                H.deploy(admin.address, { ...init, votingStart: init.registrationEnd })
            ).to.be.revertedWithCustomError(H, "InvalidTimeWindow");

            // 揭示窗口超过上限（30 天）
            await expect(
                H.deploy(admin.address, { ...init, revealEnd: init.votingEnd + 31n * 24n * HOUR })
            ).to.be.revertedWithCustomError(H, "InvalidTimeWindow");
        });

        it("★ registrationEnd 早于当前时刻应给出具名错误，而非算术 panic", async function () {
            const { init, now, pt4Addr } = await loadFixture(deployFixture);
            const [admin] = await ethers.getSigners();
            const H = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: pt4Addr },
            });

            // 若 Params.validateTimeWindows 未先判 registrationEnd <= now_，
            // 其后的减法会下溢并抛出 panic(0x11)，前端无法映射为可读文案
            await expect(
                H.deploy(admin.address, {
                    ...init,
                    registrationEnd: now - 100n,
                    votingStart: now - 50n,
                    votingEnd: now + HOUR,
                    revealEnd: now + 49n * HOUR,
                })
            ).to.be.revertedWithCustomError(H, "InvalidTimeWindow");
        });
    });

    // ============================================================
    // 2. 阶段推进（INV-5）
    // ============================================================
    describe("★ 阶段推进与边界（INV-5）", function () {
        const P = { REGISTRATION: 0n, IDLE: 1n, VOTING: 2n, REVEAL: 3n, CLOSED: 4n, FINALIZED: 5n };

        it("六个阶段按时间单调推进", async function () {
            const { h, init } = await loadFixture(deployFixture);

            expect(await h.phase()).to.equal(P.REGISTRATION);

            await time.increaseTo(init.registrationEnd);
            expect(await h.phase()).to.equal(P.IDLE);

            await time.increaseTo(init.votingStart);
            expect(await h.phase()).to.equal(P.VOTING);

            await time.increaseTo(init.votingEnd);
            expect(await h.phase()).to.equal(P.REVEAL);

            await time.increaseTo(init.revealEnd);
            // 已过揭示窗口但尚未封存 → CLOSED，而非 FINALIZED
            expect(await h.phase()).to.equal(P.CLOSED);
            expect(await h.finalized()).to.equal(false);

            await h.finalize();
            expect(await h.phase()).to.equal(P.FINALIZED);
        });

        it("★ IDLE 空档期确实存在（F-01 修正的载体）", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo((init.registrationEnd + init.votingStart) / 2n);
            expect(await h.phase()).to.equal(P.IDLE);
        });

        it("不存在任何可改变阶段的写接口", async function () {
            const { h } = await loadFixture(deployFixture);
            const names = h.interface.fragments
                .filter((f: any) => f.type === "function")
                .map((f: any) => f.name.toLowerCase());
            for (const bad of ["setphase", "pause", "unpause", "extend", "earlyclose", "forcefinalize"]) {
                expect(names).to.not.include(bad);
            }
        });
    });

    // ============================================================
    // 3. 投票记录（时窗守卫）
    // ============================================================
    describe("投票记录与时窗守卫", function () {
        it("★ 时窗守卫不使用 phase()：IDLE 期间必须判为「未开始」", async function () {
            const { h, init } = await loadFixture(deployFixture);
            // 进入 IDLE（登记已结束，投票未开始）
            await time.increaseTo(init.registrationEnd + 10n);
            expect(await h.phase()).to.equal(1n); // IDLE
            await expect(h.recordBallot(1n, ethers.id("c1"))).to.be.revertedWithCustomError(h, "VotingNotOpen");
        });

        it("登记期内投票应被拒", async function () {
            const { h } = await loadFixture(deployFixture);
            await expect(h.recordBallot(1n, ethers.id("c1"))).to.be.revertedWithCustomError(h, "VotingNotOpen");
        });

        it("投票期结束后投票应被拒", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingEnd);
            await expect(h.recordBallot(1n, ethers.id("c1"))).to.be.revertedWithCustomError(h, "VotingClosed");
        });

        it("空承诺应被拒", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingStart + 10n);
            await expect(h.recordBallot(1n, ethers.ZeroHash)).to.be.revertedWithCustomError(h, "ZeroCommitment");
        });

        it("同一假名重复投票应被拒", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingStart + 10n);
            await h.recordBallot(1n, ethers.id("c1"));
            await expect(h.recordBallot(1n, ethers.id("c2"))).to.be.revertedWithCustomError(h, "AlreadyVoted");
        });

        it("同一承诺重复提交应被拒", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingStart + 10n);
            const c = ethers.id("c1");
            await h.recordBallot(1n, c);
            await expect(h.recordBallot(2n, c)).to.be.revertedWithCustomError(h, "CommitmentAlreadyCast");
        });

        it("成功投票后计数与事件正确", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingStart + 10n);
            const c = ethers.id("c1");

            await expect(h.recordBallot(7n, c))
                .to.emit(h, "BallotCommitted")
                .withArgs(1n, 7n, c, 0n);

            expect(await h.nullifierCount()).to.equal(1n);
            expect(await h.isNullifierUsed(7n)).to.equal(true);
            expect(await h.isCommitmentCast(c)).to.equal(true);
        });

        it("投票期结束时点边界：VOTING_END 当刻即不可投", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingEnd - 2n);
            await h.recordBallot(1n, ethers.id("ok")); // 有效
            await time.increaseTo(init.votingEnd);
            await expect(h.recordBallot(2n, ethers.id("late"))).to.be.revertedWithCustomError(h, "VotingClosed");
        });
    });

    // ============================================================
    // 4. 揭示（含 F-02 关键防护）
    // ============================================================
    describe("★ 揭示与 F-02 关键防护", function () {
        async function votingFixture() {
            const f = await deployFixture();
            await time.increaseTo(f.init.votingStart + 10n);
            return f;
        }

        async function revealFixture() {
            const f = await votingFixture();
            await time.increaseTo(f.init.votingEnd + 10n);
            return f;
        }

        it("揭示期前应被拒", async function () {
            const { h, pt4, scope } = await votingFixture();
            const c = await makeCommitment(pt4, scope, 0b0001, 1n);
            await h.recordBallot(1n, c);
            await expect(h.reveal([{ ballotCommitment: c, ballotMask: 1, salt: 1n }])).to.be.revertedWithCustomError(
                h,
                "RevealNotOpen"
            );
        });

        it("揭示期结束后应被拒", async function () {
            const { h, init } = await revealFixture();
            await time.increaseTo(init.revealEnd);
            await expect(
                h.reveal([{ ballotCommitment: ethers.id("x"), ballotMask: 1, salt: 1n }])
            ).to.be.revertedWithCustomError(h, "RevealClosed");
        });

        it("空数组与超批量应被拒", async function () {
            const { h } = await revealFixture();
            await expect(h.reveal([])).to.be.revertedWithCustomError(h, "BatchTooLarge");

            const big = Array.from({ length: 101 }, () => ({
                ballotCommitment: ethers.id("y"),
                ballotMask: 1,
                salt: 1n,
            }));
            await expect(h.reveal(big)).to.be.revertedWithCustomError(h, "BatchTooLarge");
        });

        it("★ F-02：未曾在投票期上链的承诺不可揭示（否则可凭空造票）", async function () {
            const { h, pt4, scope } = await revealFixture();

            // 攻击者自造一组 (mask, salt)，计算出的承诺完全合法，
            // 但从未在投票期上链 —— 必须被拒
            const forged = await makeCommitment(pt4, scope, 0b0011, 999n);
            expect(await h.isCommitmentCast(forged)).to.equal(false);

            await expect(
                h.reveal([{ ballotCommitment: forged, ballotMask: 0b0011, salt: 999n }])
            ).to.be.revertedWithCustomError(h, "CommitmentNotCast");
        });

        it("明文与承诺不匹配应被拒", async function () {
            const { h, pt4, scope, init } = await votingFixture();
            const c = await makeCommitment(pt4, scope, 0b0001, 1n);
            await h.recordBallot(1n, c);
            await time.increaseTo(init.votingEnd + 10n);

            // 用不同的 mask/salt 去揭示同一个承诺
            await expect(
                h.reveal([{ ballotCommitment: c, ballotMask: 0b0010, salt: 1n }])
            ).to.be.revertedWithCustomError(h, "CommitmentMismatch");
        });

        it("重复揭示应被拒", async function () {
            const { h, pt4, scope, init } = await votingFixture();
            const c = await makeCommitment(pt4, scope, 0b0001, 5n);
            await h.recordBallot(1n, c);
            await time.increaseTo(init.votingEnd + 10n);

            await h.reveal([{ ballotCommitment: c, ballotMask: 0b0001, salt: 5n }]);

            await expect(
                h.reveal([{ ballotCommitment: c, ballotMask: 0b0001, salt: 5n }])
            ).to.be.revertedWithCustomError(h, "AlreadyRevealed");
        });

        it("单选计票正确，且 INV-1 / INV-2 成立", async function () {
            const { h, pt4, scope, init } = await votingFixture();

            // 3 人：分别投 0、1、1
            const ballots = [
                { mask: 0b0001, salt: 11n },
                { mask: 0b0010, salt: 12n },
                { mask: 0b0010, salt: 13n },
            ];
            for (let i = 0; i < ballots.length; i++) {
                const c = await makeCommitment(pt4, scope, ballots[i].mask, ballots[i].salt);
                await h.recordBallot(BigInt(i + 1), c);
            }
            await time.increaseTo(init.votingEnd + 10n);

            const payloads = [];
            for (const b of ballots) {
                payloads.push({
                    ballotCommitment: await makeCommitment(pt4, scope, b.mask, b.salt),
                    ballotMask: b.mask,
                    salt: b.salt,
                });
            }
            await h.reveal(payloads);

            await time.increaseTo(init.revealEnd);
            await h.finalize();

            const counts = await h.getCounts();
            expect(counts[0]).to.equal(1n);
            expect(counts[1]).to.equal(2n);

            // INV-1：票数守恒
            const sum = counts.reduce((a: bigint, b: bigint) => a + b, 0n);
            expect(sum).to.equal(await h.totalMarks());

            // INV-2：揭示数不超过参与人数
            expect(await h.revealedCount()).to.be.lessThanOrEqual(await h.nullifierCount());
        });

        it("多选计票正确（maxChoices = 2）", async function () {
            const { h, pt4, scope, init } = await votingFixture();

            // 一票选 {0,2}，一票选 {1}
            const pairs = [
                { mask: 0b0101, salt: 21n },
                { mask: 0b0010, salt: 22n },
            ];
            const payloads = [];
            for (let i = 0; i < pairs.length; i++) {
                const c = await makeCommitment(pt4, scope, pairs[i].mask, pairs[i].salt);
                await h.recordBallot(BigInt(i + 1), c);
                payloads.push({ ballotCommitment: c, ballotMask: pairs[i].mask, salt: pairs[i].salt });
            }
            await time.increaseTo(init.votingEnd + 10n);
            await h.reveal(payloads);

            await time.increaseTo(init.revealEnd);
            await h.finalize();

            const counts = await h.getCounts();
            expect(counts[0]).to.equal(1n);
            expect(counts[1]).to.equal(1n);
            expect(counts[2]).to.equal(1n);
            expect(counts[3]).to.equal(0n);
            expect(await h.totalMarks()).to.equal(3n);
        });
    });

    // ============================================================
    // 5. 违规票作废（不阻断整批）
    // ============================================================
    describe("违规票作废", function () {
        /** 只推进到投票期开始；调用方记录选票后需自行推进到揭示期 */
        async function votingFixture() {
            const f = await deployFixture();
            await time.increaseTo(f.init.votingStart + 10n);
            return f;
        }

        it("★ 一条超限票不阻断同批其余票，且被标记作废不可重试", async function () {
            const { h, pt4, scope, init } = await votingFixture();

            const bad = { mask: 0b0111, salt: 31n }; // 选 3 个，超过 maxChoices = 2
            const good = { mask: 0b0001, salt: 32n };

            const cBad = await makeCommitment(pt4, scope, bad.mask, bad.salt);
            const cGood = await makeCommitment(pt4, scope, good.mask, good.salt);
            await h.recordBallot(1n, cBad);
            await h.recordBallot(2n, cGood);

            await time.increaseTo(init.votingEnd + 10n);

            // 坏票在前，好票在后 —— 坏票不得阻断好票
            await expect(
                h.reveal([
                    { ballotCommitment: cBad, ballotMask: bad.mask, salt: bad.salt },
                    { ballotCommitment: cGood, ballotMask: good.mask, salt: good.salt },
                ])
            )
                .to.emit(h, "RevealRejected")
                .withArgs(1n, cBad, 1n) // REASON_CHOICE_LIMIT
                .and.to.emit(h, "BallotRevealed")
                .withArgs(1n, cGood, 1n);

            expect(await h.rejectedCount()).to.equal(1n);
            expect(await h.revealedCount()).to.equal(1n);
            expect(await h.revealStatusOf(cBad)).to.equal(2n); // REJECTED
            expect(await h.revealStatusOf(cGood)).to.equal(1n); // ACCEPTED

            // 被拒后不可重试
            await expect(
                h.reveal([{ ballotCommitment: cBad, ballotMask: bad.mask, salt: bad.salt }])
            ).to.be.revertedWithCustomError(h, "AlreadyRevealed");

            await time.increaseTo(init.revealEnd);
            await h.finalize();
            const counts = await h.getCounts();
            expect(counts[0]).to.equal(1n); // 只有好票被计入
        });

        it("位图越界被作废，原因码为 REASON_MASK_OUT_OF_RANGE", async function () {
            const { h, pt4, scope, init } = await votingFixture();

            const mask = 0b10000; // bit4 越界（optionCount = 4）
            const c = await makeCommitment(pt4, scope, mask, 41n);
            await h.recordBallot(1n, c);

            await time.increaseTo(init.votingEnd + 10n);

            await expect(h.reveal([{ ballotCommitment: c, ballotMask: mask, salt: 41n }]))
                .to.emit(h, "RevealRejected")
                .withArgs(1n, c, 2n); // REASON_MASK_OUT_OF_RANGE

            expect(await h.rejectedCount()).to.equal(1n);
            expect(await h.revealedCount()).to.equal(0n);
        });

        it("未揭示的票不计入结果，且不阻塞封存", async function () {
            const { h, pt4, scope, init } = await votingFixture();
            const c = await makeCommitment(pt4, scope, 0b0001, 51n);
            await h.recordBallot(1n, c);
            // 故意不揭示

            await time.increaseTo(init.revealEnd);
            await h.finalize();

            expect(await h.nullifierCount()).to.equal(1n);
            expect(await h.revealedCount()).to.equal(0n);
            const counts = await h.getCounts();
            expect(counts.reduce((a: bigint, b: bigint) => a + b, 0n)).to.equal(0n);
        });
    });

    // ============================================================
    // 6. 封存与分步公示（硬约束 3）
    // ============================================================
    describe("封存与分步公示", function () {
        it("★ 硬约束 3：封存前 getCounts / getResultHash 必须 revert", async function () {
            const { h } = await loadFixture(deployFixture);
            await expect(h.getCounts()).to.be.revertedWithCustomError(h, "ResultLocked");
            await expect(h.getResultHash()).to.be.revertedWithCustomError(h, "ResultLocked");
        });

        it("揭示窗口未结束不可封存", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.votingEnd + 10n);
            await expect(h.finalize()).to.be.revertedWithCustomError(h, "RevealWindowOpen");
        });

        it("任何人可在揭示窗口结束后封存，结果哈希非零且事件正确", async function () {
            const { h, init, carol } = await loadFixture(deployFixture);
            await time.increaseTo(init.revealEnd);

            const tx = await h.connect(carol).finalize();
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt!.blockNumber);

            await expect(tx).to.emit(h, "ProposalFinalized");

            expect(await h.finalized()).to.equal(true);
            const rh = await h.resultHash();
            expect(rh).to.not.equal(ethers.ZeroHash);
            expect(await h.getResultHash()).to.equal(rh);
        });

        it("重复封存应被拒", async function () {
            const { h, init } = await loadFixture(deployFixture);
            await time.increaseTo(init.revealEnd);
            await h.finalize();
            await expect(h.finalize()).to.be.revertedWithCustomError(h, "AlreadyFinalized");
        });

        it("★ INV-6：封存后再揭示或再投票都不改变结果", async function () {
            const { h, pt4, scope, init } = await deployFixture();
            await time.increaseTo(init.votingStart + 10n);

            const c = await makeCommitment(pt4, scope, 0b0001, 61n);
            await h.recordBallot(1n, c);

            await time.increaseTo(init.votingEnd + 10n);
            await h.reveal([{ ballotCommitment: c, ballotMask: 0b0001, salt: 61n }]);

            await time.increaseTo(init.revealEnd);
            await h.finalize();
            const before = await h.getCounts();

            // 封存后任何写路径都不可达
            await expect(h.recordBallot(2n, ethers.id("late"))).to.be.revertedWithCustomError(h, "VotingClosed");
            await expect(
                h.reveal([{ ballotCommitment: c, ballotMask: 0b0001, salt: 61n }])
            ).to.be.revertedWithCustomError(h, "RevealClosed");

            const after = await h.getCounts();
            expect(after).to.deep.equal(before);
            expect(await h.resultHash()).to.equal(await h.getResultHash());
        });
    });

    // ============================================================
    // 7. ★ 选票承诺的提案域分隔
    // ============================================================
    describe("★ 选票承诺的提案域分隔", function () {
        it("同一 (mask, salt) 在不同提案中产生不同承诺（防止跨提案关联）", async function () {
            const { pt4, init } = await loadFixture(deployFixture);
            const [admin] = await ethers.getSigners();

            const H = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: await pt4.getAddress() },
            });
            const p1 = await H.deploy(admin.address, { ...init, proposalId: 1n });
            await p1.waitForDeployment();
            const p2 = await H.deploy(admin.address, { ...init, proposalId: 2n });
            await p2.waitForDeployment();

            const scope1 = await p1.SCOPE();
            const scope2 = await p2.SCOPE();
            expect(scope1).to.not.equal(scope2);

            const mask = 0b0011;
            const salt = 12345n;
            const c1 = await makeCommitment(pt4, scope1, mask, salt);
            const c2 = await makeCommitment(pt4, scope2, mask, salt);

            // 若没有域分隔（如直接 Poseidon(mask, salt)），c1 会等于 c2，
            // 观察者即可通过比对承诺集合判定两票属于同一人
            expect(c1).to.not.equal(c2);
        });

        it("承诺绑定 scope：用其他提案的 scope 计算的承诺无法通过校验", async function () {
            const { h, pt4, init } = await loadFixture(deployFixture);
            const [admin] = await ethers.getSigners();

            const H = await ethers.getContractFactory("ProposalHarness", {
                libraries: { PoseidonT4: await pt4.getAddress() },
            });
            const other = await H.deploy(admin.address, { ...init, proposalId: 99n });
            await other.waitForDeployment();
            const otherScope = await other.SCOPE();

            await time.increaseTo(init.votingStart + 10n);

            // 用「错误 scope」算出的承诺即使上链，也无法用正确明文揭示
            const wrong = await makeCommitment(pt4, otherScope, 0b0001, 71n);
            await h.recordBallot(1n, wrong);

            await time.increaseTo(init.votingEnd + 10n);
            await expect(
                h.reveal([{ ballotCommitment: wrong, ballotMask: 0b0001, salt: 71n }])
            ).to.be.revertedWithCustomError(h, "CommitmentMismatch");
        });
    });
});
