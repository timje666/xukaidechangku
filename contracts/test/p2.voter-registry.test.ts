import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * P2 单元测试 —— VoterRegistry（地址白名单 + 承诺 Merkle 名册）
 *
 * 重点覆盖：
 *   - F-01 回归：登记有效性必须只看 registrationEnd，不受 phase() 空档期影响
 *   - INV-7：冻结后名册根不再变化
 *   - ★ 与独立参考实现（DependencyProbe）的根一致性 —— 证明树未被改坏
 *   - 名册导入的高频数据错误能被指名报错（管理员 CSV 导入场景）
 */
describe("P2 · VoterRegistry", function () {
    const SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617n;

    async function deployFixture() {
        const [admin, registrar, alice, bob, carol, outsider] = await ethers.getSigners();

        // 【硬约束】PoseidonT3 是 public 库，需先部署并链接（L5 结论）
        const PT3 = await ethers.getContractFactory("PoseidonT3");
        const pt3 = await PT3.deploy();
        await pt3.waitForDeployment();
        const pt3Addr = await pt3.getAddress();

        const now = BigInt(await time.latest());
        const registrationEnd = now + 7n * 24n * 3600n; // 7 天后
        const votingStart = registrationEnd + 3600n;

        const Registry = await ethers.getContractFactory("VoterRegistry", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const registry = await Registry.deploy(admin.address, registrationEnd);
        await registry.waitForDeployment();

        // 参考实现：直接用 LeanIMT，用于交叉验证根一致性
        const Probe = await ethers.getContractFactory("DependencyProbe", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const probe = await Probe.deploy();
        await probe.waitForDeployment();

        await registry.connect(admin).grantRole(REGISTRAR_ROLE, registrar.address);

        return {
            registry,
            probe,
            admin,
            registrar,
            alice,
            bob,
            carol,
            outsider,
            registrationEnd,
            votingStart,
        };
    }

    function commitmentFor(tag: string | number): bigint {
        return BigInt(ethers.keccak256(ethers.toUtf8Bytes(`chainvote-commitment-${tag}`))) % SNARK_SCALAR_FIELD;
    }

    const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE"));

    // ============================================================
    // 1. 初始状态
    // ============================================================
    describe("初始状态", function () {
        it("未登记、未冻结、名册为空", async function () {
            const { registry, alice } = await loadFixture(deployFixture);
            expect(await registry.isRegistered(alice.address)).to.equal(false);
            expect(await registry.commitmentOf(alice.address)).to.equal(0n);
            expect(await registry.rosterSize()).to.equal(0n);
            expect(await registry.frozen()).to.equal(false);
            expect(await registry.frozenRoot()).to.equal(0n);
        });

        it("registrationEnd = 0 应被拒绝", async function () {
            const [admin] = await ethers.getSigners();
            const PT3 = await ethers.getContractFactory("PoseidonT3");
            const pt3 = await PT3.deploy();
            await pt3.waitForDeployment();
            const R = await ethers.getContractFactory("VoterRegistry", {
                libraries: { PoseidonT3: await pt3.getAddress() },
            });
            await expect(R.deploy(admin.address, 0)).to.be.revertedWithCustomError(R, "InvalidTimeWindow");
        });

        it("未冻结时 requireFrozenRoot 应 revert（F-06）", async function () {
            const { registry } = await loadFixture(deployFixture);
            await expect(registry.requireFrozenRoot()).to.be.revertedWithCustomError(registry, "RootNotFrozen");
        });
    });

    // ============================================================
    // 2. 权限
    // ============================================================
    describe("权限", function () {
        it("无 REGISTRAR_ROLE 时登记被拒", async function () {
            const { registry, outsider, alice } = await loadFixture(deployFixture);
            await expect(registry.connect(outsider).registerVoters([alice.address], [commitmentFor(1)]))
                .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
                .withArgs(outsider.address, REGISTRAR_ROLE);
        });
    });

    // ============================================================
    // 3. ★ F-01 回归：登记期边界
    // ============================================================
    describe("★ F-01 回归 · 登记期边界", function () {
        it("登记期内可登记", async function () {
            const { registry, registrar, alice } = await loadFixture(deployFixture);
            await expect(registry.connect(registrar).registerVoters([alice.address], [commitmentFor(1)])).to.not.be
                .reverted;
            expect(await registry.isRegistered(alice.address)).to.equal(true);
            expect(await registry.rosterSize()).to.equal(1n);
        });

        it("registrationEnd 之后立即登记应被拒（含空档期与投票期）", async function () {
            const { registry, registrar, registrationEnd, votingStart, alice, bob, carol } =
                await loadFixture(deployFixture);

            // 注意块时间戳的推进规则：`increaseTo(t)` 把下一个区块的时间戳设为 t，
            // 而随后的交易会落在 t+1（Hardhat 默认不允许同时间戳的连续区块）。
            // 因此「边界前 1 秒提交交易」实际执行在 registrationEnd，
            // 应使用 2 秒余量来测试「边界内可登记」。
            await time.increaseTo(registrationEnd - 2n);
            await registry.connect(registrar).registerVoters([alice.address], [commitmentFor(1)]);
            expect(await registry.isRegistered(alice.address)).to.equal(true);

            // 恰好 registrationEnd（及其后）：不可登记
            await time.increaseTo(registrationEnd);
            await expect(registry.connect(registrar).registerVoters([bob.address], [commitmentFor(2)]))
                .to.be.revertedWithCustomError(registry, "RegistrationClosed");

            // 空档期（登记结束 ~ 投票开始）：仍不可登记 —— 这正是 F-01 指出的篡改窗口
            await time.increaseTo((registrationEnd + votingStart) / 2n);
            await expect(registry.connect(registrar).registerVoters([carol.address], [commitmentFor(3)]))
                .to.be.revertedWithCustomError(registry, "RegistrationClosed");

            // 投票期中：不可登记
            await time.increaseTo(votingStart);
            await expect(registry.connect(registrar).registerVoters([carol.address], [commitmentFor(3)]))
                .to.be.revertedWithCustomError(registry, "RegistrationClosed");

            // 名册人数始终为 1，未被篡改
            expect(await registry.rosterSize()).to.equal(1n);
        });
    });

    // ============================================================
    // 4. 入参校验（管理员 CSV 导入的高频错误）
    // ============================================================
    describe("入参校验", function () {
        it("数组长度不一致应被拒", async function () {
            const { registry, registrar, alice, bob } = await loadFixture(deployFixture);
            await expect(
                registry.connect(registrar).registerVoters([alice.address, bob.address], [commitmentFor(1)])
            ).to.be.revertedWithCustomError(registry, "ArrayLengthMismatch");
        });

        it("空数组应被拒", async function () {
            const { registry, registrar } = await loadFixture(deployFixture);
            await expect(registry.connect(registrar).registerVoters([], [])).to.be.revertedWithCustomError(
                registry,
                "BatchTooLarge"
            );
        });

        it("超过单批上限（Params.MAX_REGISTER_BATCH = 50）应被拒", async function () {
            const { registry, registrar } = await loadFixture(deployFixture);
            const signers = await ethers.getSigners();
            const voters = Array.from({ length: 51 }, (_, i) => signers[i % signers.length].address);
            const commitments = Array.from({ length: 51 }, (_, i) => commitmentFor(1000 + i));
            await expect(
                registry.connect(registrar).registerVoters(voters, commitments)
            ).to.be.revertedWithCustomError(registry, "BatchTooLarge");
        });

        it("恰好 50 个可登记（边界内）", async function () {
            const { registry, registrar } = await loadFixture(deployFixture);
            const voters = Array.from({ length: 50 }, (_, i) => ethers.Wallet.createRandom().address);
            const commitments = Array.from({ length: 50 }, (_, i) => commitmentFor(2000 + i));
            await registry.connect(registrar).registerVoters(voters, commitments);
            expect(await registry.rosterSize()).to.equal(50n);
        });

        it("承诺为 0 应被指名拒绝", async function () {
            const { registry, registrar, alice } = await loadFixture(deployFixture);
            await expect(
                registry.connect(registrar).registerVoters([alice.address], [0])
            ).to.be.revertedWithCustomError(registry, "ZeroCommitment");
        });

        it("同一地址重复登记应被指名拒绝", async function () {
            const { registry, registrar, alice } = await loadFixture(deployFixture);
            await registry.connect(registrar).registerVoters([alice.address], [commitmentFor(1)]);
            await expect(
                registry.connect(registrar).registerVoters([alice.address], [commitmentFor(2)])
            )
                .to.be.revertedWithCustomError(registry, "AlreadyRegistered")
                .withArgs(alice.address);
        });

        it("同一承诺登记给两个地址应被指名拒绝（含承诺值）", async function () {
            const { registry, registrar, alice, bob } = await loadFixture(deployFixture);
            const c = commitmentFor(7);
            await registry.connect(registrar).registerVoters([alice.address], [c]);
            await expect(registry.connect(registrar).registerVoters([bob.address], [c]))
                .to.be.revertedWithCustomError(registry, "CommitmentAlreadyUsed")
                .withArgs(c);
        });

        it("超出 SNARK 标量域的承诺由上游拒绝（本合约不重复实现）", async function () {
            const { registry, registrar, alice } = await loadFixture(deployFixture);
            // 上游 InternalLeanIMT._insert 会 revert LeafGreaterThanSnarkScalarField()
            await expect(
                registry.connect(registrar).registerVoters([alice.address], [SNARK_SCALAR_FIELD])
            ).to.be.reverted;
        });

        it("同一承诺在一批内重复出现应被指名拒绝（CSV 导入高频错误）", async function () {
            const { registry, registrar, alice, bob } = await loadFixture(deployFixture);
            const c = commitmentFor(11);
            // 同一批次内重复：必须由本合约指名报错，
            // 而不是落到上游笼统的 LeafAlreadyExists()
            await expect(
                registry.connect(registrar).registerVoters([alice.address, bob.address], [c, c])
            )
                .to.be.revertedWithCustomError(registry, "CommitmentAlreadyUsed")
                .withArgs(c);
        });

        it("批量登记中途失败时整笔回滚（无部分写入）", async function () {
            const { registry, registrar, alice, bob, carol } = await loadFixture(deployFixture);
            const c = commitmentFor(9);
            // 中间一项使用已存在的承诺 → 整笔 revert
            await expect(
                registry.connect(registrar).registerVoters(
                    [alice.address, bob.address, carol.address],
                    [commitmentFor(8), c, c]
                )
            ).to.be.revertedWithCustomError(registry, "CommitmentAlreadyUsed");

            // 回滚彻底：无任何地址被写入
            expect(await registry.isRegistered(alice.address)).to.equal(false);
            expect(await registry.isRegistered(bob.address)).to.equal(false);
            expect(await registry.rosterSize()).to.equal(0n);
        });
    });

    // ============================================================
    // 5. 名册树行为
    // ============================================================
    describe("名册树", function () {
        it("插入后 size / depth / root 正确演进", async function () {
            const { registry, registrar, alice, bob } = await loadFixture(deployFixture);

            await registry.connect(registrar).registerVoters([alice.address], [commitmentFor(1)]);
            expect(await registry.rosterSize()).to.equal(1n);
            const root1 = await registry.currentRoot();
            expect(root1).to.not.equal(0n);

            await registry.connect(registrar).registerVoters([bob.address], [commitmentFor(2)]);
            expect(await registry.rosterSize()).to.equal(2n);
            expect(await registry.currentRoot()).to.not.equal(root1);
        });

        it("事件携带连续 leafIndex，供链下按序重建", async function () {
            const { registry, registrar, alice, bob, carol } = await loadFixture(deployFixture);
            const c1 = commitmentFor(1);
            const c2 = commitmentFor(2);
            const c3 = commitmentFor(3);

            await expect(registry.connect(registrar).registerVoters([alice.address], [c1]))
                .to.emit(registry, "VoterRegistered")
                .withArgs(alice.address, c1, 0n);

            await expect(
                registry.connect(registrar).registerVoters([bob.address, carol.address], [c2, c3])
            )
                .to.emit(registry, "VoterRegistered")
                .withArgs(bob.address, c2, 1n)
                .and.to.emit(registry, "VoterRegistered")
                .withArgs(carol.address, c3, 2n);
        });

        it("isEnrolled 可判定承诺是否在树中（不泄露地址）", async function () {
            const { registry, registrar, alice } = await loadFixture(deployFixture);
            const c = commitmentFor(1);
            await registry.connect(registrar).registerVoters([alice.address], [c]);
            expect(await registry.isEnrolled(c)).to.equal(true);
            expect(await registry.isEnrolled(commitmentFor(999))).to.equal(false);
        });
    });

    // ============================================================
    // 6. ★ 与独立参考实现的根一致性
    // ============================================================
    describe("★ 与独立参考实现的根一致性", function () {
        it("相同承诺、相同顺序 → VoterRegistry 与直接使用 LeanIMT 的根逐位一致", async function () {
            const { registry, probe, registrar } = await loadFixture(deployFixture);

            const commitments = Array.from({ length: 30 }, (_, i) => commitmentFor(3000 + i));
            const voters = Array.from({ length: 30 }, () => ethers.Wallet.createRandom().address);

            await registry.connect(registrar).registerVoters(voters, commitments);

            // 参考实现：逐条插入同样的承诺
            for (const c of commitments) {
                await probe.insert(c);
            }

            expect(await registry.currentRoot()).to.equal(await probe.root());
            expect(await registry.rosterSize()).to.equal(await probe.size());
            expect(await registry.rosterDepth()).to.equal(await probe.depth());
        });

        it("分批登记与一次性登记的根一致（批次不改变树形）", async function () {
            const { registry, probe, registrar } = await loadFixture(deployFixture);

            const all = Array.from({ length: 20 }, (_, i) => commitmentFor(4000 + i));
            const voters = Array.from({ length: 20 }, () => ethers.Wallet.createRandom().address);

            // 分成 4 批，每批 5 个
            for (let b = 0; b < 4; b++) {
                await registry
                    .connect(registrar)
                    .registerVoters(voters.slice(b * 5, b * 5 + 5), all.slice(b * 5, b * 5 + 5));
            }

            for (const c of all) await probe.insert(c);

            expect(await registry.currentRoot()).to.equal(await probe.root());
        });
    });

    // ============================================================
    // 7. 冻结与 INV-7
    // ============================================================
    describe("名册根固化与 INV-7", function () {
        it("登记期结束前不可固化", async function () {
            const { registry } = await loadFixture(deployFixture);
            await expect(registry.freezeVotersRoot()).to.be.revertedWithCustomError(
                registry,
                "RegistrationNotEnded"
            );
        });

        it("空名册不可固化（无人登记不构成有效投票）", async function () {
            const { registry, registrationEnd } = await loadFixture(deployFixture);
            await time.increaseTo(registrationEnd);
            await expect(registry.freezeVotersRoot()).to.be.revertedWithCustomError(registry, "EmptyRoster");
        });

        it("登记期结束后任何人可固化，且计数与根正确", async function () {
            const { registry, registrar, outsider, registrationEnd, alice, bob } = await loadFixture(
                deployFixture
            );
            await registry
                .connect(registrar)
                .registerVoters([alice.address, bob.address], [commitmentFor(1), commitmentFor(2)]);
            const expectRoot = await registry.currentRoot();

            await time.increaseTo(registrationEnd);
            await expect(registry.connect(outsider).freezeVotersRoot())
                .to.emit(registry, "VotersRootFrozen")
                .withArgs(expectRoot, 2n, anyValue);

            expect(await registry.frozen()).to.equal(true);
            expect(await registry.frozenRoot()).to.equal(expectRoot);
            expect(await registry.eligibleCount()).to.equal(2n);
            expect(await registry.requireFrozenRoot()).to.equal(expectRoot);
        });

        it("重复固化应被拒（幂等性以 revert 表达，便于前端区分状态）", async function () {
            const { registry, registrar, registrationEnd, alice } = await loadFixture(deployFixture);
            await registry.connect(registrar).registerVoters([alice.address], [commitmentFor(1)]);
            await time.increaseTo(registrationEnd);

            await registry.freezeVotersRoot();
            await expect(registry.freezeVotersRoot()).to.be.revertedWithCustomError(
                registry,
                "RootAlreadyFrozen"
            );
        });

        it("★ INV-7：冻结后名册根不再变化，且不可再登记", async function () {
            const { registry, registrar, registrationEnd, alice, bob, carol } = await loadFixture(deployFixture);
            await registry
                .connect(registrar)
                .registerVoters([alice.address, bob.address], [commitmentFor(1), commitmentFor(2)]);
            await time.increaseTo(registrationEnd);
            await registry.freezeVotersRoot();

            const frozenRoot = await registry.frozenRoot();
            const frozenCount = await registry.eligibleCount();

            // 尝试追加登记 → 被拒
            await expect(
                registry.connect(registrar).registerVoters([carol.address], [commitmentFor(3)])
            ).to.be.revertedWithCustomError(registry, "RegistrationClosed");

            // 根与人数均未变化
            expect(await registry.frozenRoot()).to.equal(frozenRoot);
            expect(await registry.currentRoot()).to.equal(frozenRoot);
            expect(await registry.eligibleCount()).to.equal(frozenCount);
            expect(await registry.rosterSize()).to.equal(frozenCount);
        });
    });
});
