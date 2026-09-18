import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * P1 单元测试 —— 角色体系与权限边界
 *
 * 覆盖：
 *   - 角色常量的定义与唯一性
 *   - DEFAULT_ADMIN_ROLE 的初始授予
 *   - 两个业务角色的门禁行为（未授权必拒 / 授权后可调 / 撤销后失效）
 *   - 冻结 Q4：系统不存在任何暂停能力
 */
describe("P1 · 角色体系与权限边界", function () {
    const CREATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.CREATOR_ROLE"));
    const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE"));
    const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

    async function deployFixture() {
        const [admin, creator, registrar, outsider] = await ethers.getSigners();
        const H = await ethers.getContractFactory("AccessControlHarness");
        const h = await H.deploy(admin.address);
        await h.waitForDeployment();
        return { h, admin, creator, registrar, outsider };
    }

    // ============================================================
    // 1. 角色常量
    // ============================================================
    describe("角色的定义", function () {
        it("CREATOR_ROLE 与 REGISTRAR_ROLE 哈希与链下计算一致", async function () {
            const { h } = await loadFixture(deployFixture);
            const [r1, r2] = await h.roleMatrix();
            expect(r1).to.equal(CREATOR_ROLE);
            expect(r2).to.equal(REGISTRAR_ROLE);
        });

        it("两个业务角色互不相同，且都不等于 DEFAULT_ADMIN_ROLE", async function () {
            const { h } = await loadFixture(deployFixture);
            const [r1, r2] = await h.roleMatrix();
            expect(r1).to.not.equal(r2);
            expect(r1).to.not.equal(DEFAULT_ADMIN_ROLE);
            expect(r2).to.not.equal(DEFAULT_ADMIN_ROLE);
        });

        it("角色名可读，便于运维日志排查", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.roleName(CREATOR_ROLE)).to.equal("CREATOR_ROLE");
            expect(await h.roleName(REGISTRAR_ROLE)).to.equal("REGISTRAR_ROLE");
            expect(await h.roleName(DEFAULT_ADMIN_ROLE)).to.equal("DEFAULT_ADMIN_ROLE");
            expect(await h.roleName(ethers.keccak256(ethers.toUtf8Bytes("NOPE")))).to.equal(
                "UNKNOWN_ROLE"
            );
        });

        it("Roles.count() 与 Roles.all().length 保持一致", async function () {
            const { h } = await loadFixture(deployFixture);
            const matrix = await h.roleMatrix();
            const count = await h.roleCount();
            // 新增角色时若只改 all() 而忘了改 count()，此处立即失败
            expect(count).to.equal(BigInt(matrix.length));
        });
    });

    // ============================================================
    // 2. 初始管理员
    // ============================================================
    describe("DEFAULT_ADMIN_ROLE 的授予", function () {
        it("部署时仅授予 initialAdmin，且不授予任何业务角色", async function () {
            const { h, admin } = await loadFixture(deployFixture);
            expect(await h.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
            // 【关键】部署者不是业务管理员 —— 业务角色必须显式单独授予
            expect(await h.hasRole(CREATOR_ROLE, admin.address)).to.equal(false);
            expect(await h.hasRole(REGISTRAR_ROLE, admin.address)).to.equal(false);
        });

        it("零地址作为初始管理员应被拒绝", async function () {
            const H = await ethers.getContractFactory("AccessControlHarness");
            await expect(H.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(H, "ZeroAddress");
        });
    });

    // ============================================================
    // 3. 角色门禁行为
    // ============================================================
    describe("业务角色门禁", function () {
        it("无 CREATOR_ROLE 时 createProposal 被拒绝（含管理员本人）", async function () {
            const { h, admin, outsider } = await loadFixture(deployFixture);
            const expectedRole = CREATOR_ROLE;

            await expect(h.connect(outsider).createProposal())
                .to.be.revertedWithCustomError(h, "AccessControlUnauthorizedAccount")
                .withArgs(outsider.address, expectedRole);

            // 管理员只有 DEFAULT_ADMIN_ROLE，未经授予同样不能创建
            await expect(h.connect(admin).createProposal())
                .to.be.revertedWithCustomError(h, "AccessControlUnauthorizedAccount")
                .withArgs(admin.address, expectedRole);
        });

        it("无 REGISTRAR_ROLE 时 registerVoter 被拒绝", async function () {
            const { h, outsider, registrar } = await loadFixture(deployFixture);
            await expect(h.connect(outsider).registerVoter(registrar.address))
                .to.be.revertedWithCustomError(h, "AccessControlUnauthorizedAccount")
                .withArgs(outsider.address, REGISTRAR_ROLE);
        });

        it("授予 CREATOR_ROLE 后可创建提案", async function () {
            const { h, admin, creator } = await loadFixture(deployFixture);
            await h.connect(admin).grantRole(CREATOR_ROLE, creator.address);

            await expect(h.connect(creator).createProposal())
                .to.emit(h, "ProposalCreatedBy")
                .withArgs(creator.address, 1n);
            expect(await h.proposalCount()).to.equal(1n);
        });

        it("授予 REGISTRAR_ROLE 后可登记选民", async function () {
            const { h, admin, registrar, outsider } = await loadFixture(deployFixture);
            await h.connect(admin).grantRole(REGISTRAR_ROLE, registrar.address);

            await expect(h.connect(registrar).registerVoter(outsider.address))
                .to.emit(h, "VoterRegisteredBy")
                .withArgs(registrar.address, outsider.address);
            expect(await h.isRegistered(outsider.address)).to.equal(true);
        });

        it("撤销角色后权限立即失效", async function () {
            const { h, admin, creator } = await loadFixture(deployFixture);
            await h.connect(admin).grantRole(CREATOR_ROLE, creator.address);
            expect(await h.hasRole(CREATOR_ROLE, creator.address)).to.equal(true);

            await h.connect(admin).revokeRole(CREATOR_ROLE, creator.address);
            expect(await h.hasRole(CREATOR_ROLE, creator.address)).to.equal(false);

            await expect(h.connect(creator).createProposal()).to.be.revertedWithCustomError(
                h,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("非管理员无权授予角色", async function () {
            const { h, outsider, creator } = await loadFixture(deployFixture);
            await expect(h.connect(outsider).grantRole(CREATOR_ROLE, creator.address))
                .to.be.revertedWithCustomError(h, "AccessControlUnauthorizedAccount")
                .withArgs(outsider.address, DEFAULT_ADMIN_ROLE);
        });

        it("角色变更全部事件留痕（支撑 R4 权限泄漏监控）", async function () {
            const { h, admin, creator } = await loadFixture(deployFixture);
            await expect(h.connect(admin).grantRole(CREATOR_ROLE, creator.address))
                .to.emit(h, "RoleGranted")
                .withArgs(CREATOR_ROLE, creator.address, admin.address);

            await expect(h.connect(admin).revokeRole(CREATOR_ROLE, creator.address))
                .to.emit(h, "RoleRevoked")
                .withArgs(CREATOR_ROLE, creator.address, admin.address);
        });
    });

    // ============================================================
    // 4. 冻结 Q4：无暂停能力
    // ============================================================
    describe("冻结 Q4 · 无任何票期干预能力", function () {
        it("hasPauseCapability 恒为 false", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.hasPauseCapability()).to.equal(false);
        });

        it("合约不暴露任何暂停类外部函数", async function () {
            const { h } = await loadFixture(deployFixture);
            const names = h.interface.fragments
                .filter((f: any) => f.type === "function")
                .map((f: any) => f.name.toLowerCase());

            const forbidden = ["pause", "unpause", "setpaused", "halt", "freezevote"];
            for (const bad of forbidden) {
                expect(names).to.not.include(bad);
            }
        });
    });
});
