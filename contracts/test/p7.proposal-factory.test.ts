/**
 * P7 · ProposalFactory 单元测试
 *
 * 覆盖范围（同时满足 HC-19「每个错误被引用」与覆盖率门禁）：
 *   · 创建：经 `CREATOR_ROLE` 创建、编号自增、双索引写入、`ProposalCreated` 事件
 *   · 全局角色：`CREATOR_ROLE` 门禁（越权 revert AccessControlUnauthorizedAccount）
 *   · 创建码体积防御：`init.proposalId != 0` 必 revert `ProposalIdMustBeZero`
 *   · 索引查询：`proposalAt` / `proposalOf` / `isProposal` 正常路径与越界/未知 revert `UnknownProposal`
 *   · 多提案并行：连续创建 N 个，编号 ↔ 地址一一对应，且 `proposalCount == proposalsLength`
 *   · 不可变冻结：每个新建提案的初始管理员恒为工厂的 `PROPOSAL_ADMIN`（不允许调用方指定）
 *
 * 注意：本测试只验证工厂的「创建 / 索引 / 全局角色」职责，不驱动提案状态机
 * （那是 P3~P6 的覆盖范围）。工厂部署 `Proposal` 时把创建码内联，故本 fixture 部署工厂
 * 时必须链接 PoseidonT4。
 *
 * ⚠️ ethers v6 约定：状态变更函数（非 `view`）的 `returns` 值**不能**通过调用直接解构
 * （返回的是交易响应 `ContractTransactionResponse`）。故地址一律从事件或工厂索引读回。
 */

import { expect } from "chai";
import { ethers } from "hardhat";

import { buildProposalInit, buildTimeWindows } from "./helpers/proposal";

describe("P7 · ProposalFactory（创建 / 索引 / 全局角色）", function () {
    async function deployFixture() {
        const [admin, registrar, outsider] = await ethers.getSigners();

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

        const now = BigInt(await ethers.provider.getBlock("latest").then((b) => b!.timestamp));
        const tw = buildTimeWindows(now);

        const R = await ethers.getContractFactory("VoterRegistry", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const registry = await R.deploy(admin.address, tw.registrationEnd);
        await registry.waitForDeployment();

        // 工厂把 Proposal 创建码内联，部署时须链接 PoseidonT4
        const FACTORY = await ethers.getContractFactory("ProposalFactory", {
            libraries: { PoseidonT4: pt4Addr },
        });
        const factory = await FACTORY.deploy(admin.address);
        await factory.waitForDeployment();

        const CREATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.CREATOR_ROLE"));
        await factory.connect(admin).grantRole(CREATOR_ROLE, admin.address);

        return { admin, registrar, outsider, factory, registry, verifierAddr, tw, pt3Addr, pt4Addr };
    }

    /** 构造一个合法的 createProposal 入参（proposalId 默认 0，交由工厂分配） */
    function initInput(f: Awaited<ReturnType<typeof deployFixture>>, proposalId = 0n) {
        return buildProposalInit({
            proposalId,
            registry: f.registry.getAddress(),
            verifier: f.verifierAddr,
            ...f.tw,
        });
    }

    /** 创建并返回 [编号, 地址]（地址从事件/索引读回，避免解构交易响应） */
    async function createOne(f: Awaited<ReturnType<typeof deployFixture>>) {
        const tx = await f.factory.connect(f.admin).createProposal(initInput(f));
        const receipt = await tx.wait();
        const iface = f.factory.interface;
        const createdTopic = iface.getEvent("ProposalCreated").topicHash;
        const log = receipt!.logs.find((l: any) => l.topics[0] === createdTopic);
        const ev = iface.parseLog(log!);
        const addr: string = ev.args.proposal;
        const id: bigint = ev.args.proposalId;
        return { id, addr, ev, receipt };
    }

    it("经 CREATOR_ROLE 创建：编号自增、双索引、事件、PROPOSAL_ADMIN 冻结", async function () {
        const f = await deployFixture();

        expect(await f.factory.proposalCount(), "初始 proposalCount 应为 0").to.equal(0n);

        const { id, addr, ev } = await createOne(f);

        // 事件参数
        expect(ev.args.proposalId, "事件 proposalId 应为 1").to.equal(1n);
        expect(ev.args.creator, "事件 creator 应为 admin").to.equal(f.admin.address);
        expect(id, "返回的编号应为 1").to.equal(1n);

        expect(await f.factory.proposalCount(), "proposalCount 应自增到 1").to.equal(1n);
        expect(await f.factory.proposalsLength(), "proposalsLength 应等于 1").to.equal(1n);

        expect(await f.factory.proposalAt(0n), "proposalAt(0) 应等于 proposalOf(1)").to.equal(addr);
        expect(await f.factory.proposalOf(1n), "proposalOf(1) 应等于事件中的地址").to.equal(addr);
        expect(await f.factory.isProposal(addr), "工厂创建的地址应被 isProposal 识别").to.equal(true);

        // 每个新建提案的初始管理员必须冻结为工厂的 PROPOSAL_ADMIN（不允许调用方指定）
        const proposal = await ethers.getContractAt("Proposal", addr);
        const PROPOSAL_ADMIN = await f.factory.PROPOSAL_ADMIN();
        expect(PROPOSAL_ADMIN, "工厂 PROPOSAL_ADMIN 应为部署者").to.equal(f.admin.address);
        expect(
            await proposal.hasRole(await proposal.DEFAULT_ADMIN_ROLE(), PROPOSAL_ADMIN),
            "提案初始管理员必须恒为工厂的 PROPOSAL_ADMIN"
        ).to.equal(true);
    });

    it("越权（无 CREATOR_ROLE）创建必 revert", async function () {
        const f = await deployFixture();
        await expect(
            f.factory.connect(f.outsider).createProposal(initInput(f))
        ).to.be.revertedWithCustomError(f.factory, "AccessControlUnauthorizedAccount");
    });

    it("proposalId 非 0 必 revert ProposalIdMustBeZero（HC-19 引用点）", async function () {
        const f = await deployFixture();
        await expect(
            f.factory.connect(f.admin).createProposal(initInput(f, 999n))
        ).to.be.revertedWithCustomError(f.factory, "ProposalIdMustBeZero");
    });

    it("多提案并行：连续创建 N 个，编号↔地址一一对应且计数恒等", async function () {
        const f = await deployFixture();
        const N = 5;
        const addrs: string[] = [];
        for (let i = 0; i < N; i++) {
            const { id, addr } = await createOne(f);
            expect(id, `第 ${i + 1} 次创建应返回编号 ${i + 1}`).to.equal(BigInt(i + 1));
            addrs.push(addr);
        }

        expect(await f.factory.proposalCount(), "proposalCount 应等于 N").to.equal(BigInt(N));
        expect(await f.factory.proposalsLength(), "proposalsLength 应等于 N").to.equal(BigInt(N));

        // 编号 ↔ 下标 ↔ 地址 三者一致
        for (let i = 0; i < N; i++) {
            expect(await f.factory.proposalOf(BigInt(i + 1)), `proposalOf(${i + 1}) 错位`).to.equal(
                addrs[i]
            );
            expect(await f.factory.proposalAt(BigInt(i)), `proposalAt(${i}) 错位`).to.equal(
                addrs[i]
            );
        }
    });

    it("proposalAt 越界必 revert UnknownProposal（HC-19 引用点）", async function () {
        const f = await deployFixture();
        await f.factory.connect(f.admin).createProposal(initInput(f));
        await expect(
            f.factory.proposalAt(5n) // 仅 1 条，下标 5 越界
        ).to.be.revertedWithCustomError(f.factory, "UnknownProposal");
    });

    it("proposalOf 未知编号必 revert UnknownProposal（HC-19 引用点）", async function () {
        const f = await deployFixture();
        await f.factory.connect(f.admin).createProposal(initInput(f));
        await expect(
            f.factory.proposalOf(42n) // 仅 1 条，编号 42 不存在
        ).to.be.revertedWithCustomError(f.factory, "UnknownProposal");
    });

    it("isProposal 对无关地址返回 false", async function () {
        const f = await deployFixture();
        const { addr } = await createOne(f);
        expect(
            await f.factory.isProposal(f.outsider.address),
            "无关地址不应被识别为提案"
        ).to.equal(false);
        expect(await f.factory.isProposal(addr), "工厂创建的地址应被识别为提案").to.equal(true);
    });
});
