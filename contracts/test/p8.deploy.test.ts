import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
    CREATOR_ROLE,
    DEFAULT_TIMELOCK_MIN_DELAY,
    DEPLOY_ORDER,
    deployAll,
    resolveConfigFromEnv,
    serializeDeployment,
    type Deployment,
} from "../script/deploy-core";

/**
 * P8 · 部署脚本测试
 *
 * 覆盖 P8 的三条 DoD：
 *   ① anvil 二次执行地址一致  → 地址由 (deployer, nonce) 复现（CREATE 地址预测）
 *   ② 部署者无业务角色        → 部署者既不持有 DEFAULT_ADMIN 也不持有 CREATOR
 *   ③ 浏览器可验证            → 产物含构造参数与库地址（源码验证所需的全部输入）
 *
 * 以及 P4 移交给 P8 的必做项：断言 `Proposal.VERIFIER` 是官方验证器而非测试替身。
 *
 * 本文件**直接调用部署核心**（script/deploy-core.ts），与真实部署走同一份代码，
 * 因此不存在「测试里一套、脚本里另一套」的漂移。
 *
 * 跨进程一致性（换台机器 / 重置链）无法在进程内模拟，由
 * scripts/check-deploy-determinism.mjs 以两个独立进程各跑一次全链部署来把关。
 */

const DAY = 86400n;

/** 反推部署起始 nonce，并断言 5 个合约占满连续 nonce 且顺序固定。
 *  优先使用 deployAll 记录的 deployNonce0（精确）；仅在缺失时向后搜索作为防御。 */
function assertSequentialCreateAddresses(dep: Deployment, deployer: string): number {
    const names = Object.keys(dep.contracts);
    expect(names, "合约必须按 DEPLOY_ORDER 顺序部署").to.deep.equal([...DEPLOY_ORDER]);

    const first = dep.contracts.PoseidonT3.address.toLowerCase();
    let nonce0 = dep.deployNonce0;
    if (nonce0 === undefined || nonce0 < 0) {
        nonce0 = -1;
        for (let n = 0; n < 2048; n += 1) {
            if (ethers.getCreateAddress({ from: deployer, nonce: n }).toLowerCase() === first) {
                nonce0 = n;
                break;
            }
        }
    }
    expect(
        nonce0,
        "无法用 (deployer, nonce) 复现首个合约地址 —— 部署引入了额外状态或随机量"
    ).to.be.greaterThan(-1);

    names.forEach((name, i) => {
        const predicted = ethers.getCreateAddress({ from: deployer, nonce: nonce0 + i }).toLowerCase();
        expect(dep.contracts[name].address.toLowerCase(), `${name} 的地址不可由 (deployer, nonce) 复现`).to.equal(
            predicted
        );
    });
    return nonce0;
}

/** 取某合约运行时字节码里全部库链接槽的实际内容 */
async function readLinkSlots(contractName: string, address: string): Promise<string[]> {
    const art = (await artifacts.readArtifact(contractName)) as unknown as {
        deployedLinkReferences: Record<string, Record<string, { start: number; length: number }[]>>;
    };
    const positions = Object.values(art.deployedLinkReferences)
        .flatMap((byName) => Object.values(byName))
        .flat();
    const code = (await ethers.provider.getCode(address)).replace(/^0x/, "");
    return positions.map(({ start, length }) => code.slice(start * 2, (start + length) * 2));
}

/** 地址在字节码链接槽里的表示：40 位十六进制、保留完整 20 字节（不可去前导零，
 *  否则地址形如 0x07… 会被误截成 71586…，与运行时字节码里的 20 字节槽不符） */
const asSlot = (addr: string) => addr.toLowerCase().replace(/^0x/, "");

describe("P8 · 部署脚本（script/deploy.ts 的核心逻辑）", function () {
    let dep: Deployment;
    let deployerAddr: string;
    let electionAdmin: string;

    before(async function () {
        const signers = await ethers.getSigners();
        deployerAddr = await signers[0].getAddress();
        electionAdmin = await signers[1].getAddress();

        dep = await deployAll({
            proposer: deployerAddr,
            electionAdmin,
            fastForward: true,
            smoke: true,
        });
    });

    // ============================================================
    // DoD ①：地址确定性
    // ============================================================
    describe("地址确定性（DoD：anvil 二次执行地址一致）", function () {
        it("合约按固定顺序、同一账户以 CREATE 部署，地址可由 (deployer, nonce) 复现", function () {
            assertSequentialCreateAddresses(dep, deployerAddr);
        });

        it("同一份参数再部署一次，地址序列仍然只由 nonce 决定（无随机量）", async function () {
            const again = await deployAll({
                proposer: deployerAddr,
                electionAdmin,
                fastForward: true,
                smoke: false,
            });

            // ① 第二轮同样满足「连续 nonce + 固定顺序」
            const nonce0First = assertSequentialCreateAddresses(dep, deployerAddr);
            const nonce0Second = assertSequentialCreateAddresses(again, deployerAddr);

            // ② 两轮的起始 nonce 差值 = 第一轮消耗的交易数；第二轮接着第一轮继续，
            //    这一关系只有在「部署过程完全可预测」时才成立
            expect(nonce0Second, "第二轮应接着第一轮的 nonce 继续").to.be.greaterThan(nonce0First);
            expect(again.contracts.PoseidonT3.address).to.equal(
                ethers.getCreateAddress({ from: deployerAddr, nonce: nonce0Second })
            );

            // ③ 排程用的 salt 必须是**固定常量**（若改成随机 salt，时间锁操作的
            //    可审计性就没了：任何人都无法在事前复算出 operationId）。
            //    注意 operationId 含目标地址，故它随工厂地址变化是正确行为；
            //    要断言的是「可由记录字段复算」而非「两轮相同」。
            for (const run of [dep, again]) {
                const op = run.timelockOperations[0];
                expect(op.salt, "salt 必须是固定常量").to.equal(ethers.id("chainvote:grant:CREATOR_ROLE"));
                const timelock = await ethers.getContractAt("Timelock", run.contracts.Timelock.address);
                expect(
                    await timelock.hashOperation(op.target, 0, op.data, ethers.ZeroHash, op.salt),
                    "operationId 必须可由 (target, data, salt) 在链上复算"
                ).to.equal(op.operationId);
            }
        });

        it("跨进程一致性由 scripts/check-deploy-determinism.mjs 把关（已接入 CI 门禁 6）", function () {
            // 进程内无法真正模拟「换台机器重跑」。该门禁用两个独立进程各跑一次全链部署，
            // 并逐字段比对产物（忽略 deployedAt 与链上时间戳），对应 DoD 原文。
            expect(dep.chainId).to.be.oneOf([31337, 1337]);
        });
    });

    // ============================================================
    // DoD ②：部署者无业务角色
    // ============================================================
    describe("权限移交（DoD：部署者无业务角色）", function () {
        it("工厂的初始管理员是 Timelock，不是部署者", async function () {
            const factory = await ethers.getContractAt("ProposalFactory", dep.contracts.ProposalFactory.address);
            const timelock = dep.contracts.Timelock.address;

            expect(await factory.PROPOSAL_ADMIN()).to.equal(timelock);
            expect(await factory.hasRole(ethers.ZeroHash, timelock), "Timelock 应持有工厂管理员").to.equal(true);
            expect(await factory.hasRole(ethers.ZeroHash, deployerAddr), "部署者不得保留工厂管理员").to.equal(false);
            expect(await factory.hasRole(CREATOR_ROLE, deployerAddr), "部署者不得持有业务角色").to.equal(false);
        });

        it("每个新提案的管理员都是 Timelock（PROPOSAL_ADMIN 在工厂构造时冻结）", async function () {
            const proposal = await ethers.getContractAt("Proposal", dep.smoke!.proposal);
            expect(await proposal.hasRole(ethers.ZeroHash, dep.contracts.Timelock.address)).to.equal(true);
            expect(await proposal.hasRole(ethers.ZeroHash, deployerAddr)).to.equal(false);
        });

        it("时间锁自管理：DEFAULT_ADMIN_ROLE 不在任何 EOA 手上，也不在零地址", async function () {
            const timelock = await ethers.getContractAt("Timelock", dep.contracts.Timelock.address);
            expect(await timelock.hasRole(ethers.ZeroHash, dep.contracts.Timelock.address)).to.equal(true);
            expect(await timelock.hasRole(ethers.ZeroHash, deployerAddr)).to.equal(false);
            expect(await timelock.hasRole(ethers.ZeroHash, ethers.ZeroAddress)).to.equal(false);
        });

        it("非本地网络缺少 TIMELOCK_PROPOSER 时拒绝部署（fail-closed）", function () {
            const saved = process.env.TIMELOCK_PROPOSER;
            delete process.env.TIMELOCK_PROPOSER;
            try {
                expect(() => resolveConfigFromEnv("base", 8453, deployerAddr)).to.throw(/TIMELOCK_PROPOSER/);
            } finally {
                if (saved !== undefined) process.env.TIMELOCK_PROPOSER = saved;
            }
        });

        it("本地网络默认由部署者排程，延时默认 2 天、执行方开放、管理员自管理", function () {
            const saved = process.env.TIMELOCK_PROPOSER;
            delete process.env.TIMELOCK_PROPOSER;
            try {
                const cfg = resolveConfigFromEnv("hardhat", 31337, deployerAddr, electionAdmin);
                expect(cfg.proposer).to.equal(deployerAddr);
                expect(cfg.timelockMinDelay).to.equal(DEFAULT_TIMELOCK_MIN_DELAY);
                expect(cfg.executors).to.deep.equal([ethers.ZeroAddress]);
                expect(cfg.admin).to.equal(ethers.ZeroAddress);
            } finally {
                if (saved !== undefined) process.env.TIMELOCK_PROPOSER = saved;
            }
        });
    });

    // ============================================================
    // 接线自检与真实验证器
    // ============================================================
    describe("接线自检（含 P4 移交的「验证器不得为替身」必做项）", function () {
        it("部署脚本产出的自检项全部通过，且数量足以覆盖关键不变量", function () {
            expect(dep.checks.filter((c) => !c.ok).map((c) => c.name)).to.deep.equal([]);
            expect(dep.checks.length).to.be.greaterThan(15);
        });

        it("ZK 验证器是官方 SemaphoreVerifier，与官方运行时字节码逐字节一致", async function () {
            const code = await ethers.provider.getCode(dep.contracts.SemaphoreVerifier.address);
            const art = await artifacts.readArtifact("SemaphoreVerifier");
            expect(code.length).to.be.greaterThan(2);
            expect(code, "验证器无链接依赖，可直接与 artifact 比对").to.equal(art.deployedBytecode);
        });

        it("测试替身 MockVerifier 与真实验证器字节码不同，且部署的不是替身", async function () {
            const mock = await artifacts.readArtifact("MockVerifier");
            const real = await artifacts.readArtifact("SemaphoreVerifier");
            expect(mock.deployedBytecode).to.not.equal(real.deployedBytecode);
            expect(await ethers.provider.getCode(dep.contracts.SemaphoreVerifier.address)).to.not.equal(
                mock.deployedBytecode
            );
        });

        it("PoseidonT4 已填入工厂运行时字节码的每一个链接槽", async function () {
            const slots = await readLinkSlots("ProposalFactory", dep.contracts.ProposalFactory.address);
            expect(slots.length, "工厂应当存在 PoseidonT4 链接槽").to.be.greaterThan(0);
            for (const slot of slots) {
                expect(slot).to.equal(asSlot(dep.contracts.PoseidonT4.address));
            }
        });

        it("PoseidonT3 已填入名册合约的每一个链接槽", async function () {
            const slots = await readLinkSlots("VoterRegistry", dep.smoke!.registry);
            expect(slots.length, "名册应当存在 PoseidonT3 链接槽").to.be.greaterThan(0);
            for (const slot of slots) {
                expect(slot).to.equal(asSlot(dep.contracts.PoseidonT3.address));
            }
        });
    });

    // ============================================================
    // 时间锁
    // ============================================================
    describe("Timelock（治理时间锁）", function () {
        it("构造期拒绝低于下限的延时（fail-closed）", async function () {
            const T = await ethers.getContractFactory("Timelock");
            await expect(
                T.deploy(DAY, [deployerAddr], [ethers.ZeroAddress], ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(T, "TimelockDelayTooShort");
        });

        it("已部署时间锁的下限常量为 2 天，且 minDelay 与部署参数一致", async function () {
            const timelock = await ethers.getContractAt("Timelock", dep.contracts.Timelock.address);
            expect(await timelock.MIN_TIMELOCK_DELAY()).to.equal(2n * DAY);
            expect(await timelock.getMinDelay()).to.equal(dep.timelock.minDelay);
        });

        it("排程 → 未到期不可执行 → 到期后执行 → 角色生效", async function () {
            const T = await ethers.getContractFactory("Timelock");
            const tl = await T.deploy(2n * DAY, [deployerAddr], [ethers.ZeroAddress], ethers.ZeroAddress);
            await tl.waitForDeployment();

            const [signer] = await ethers.getSigners();
            const target = await tl.getAddress();
            const proposerRole = await tl.PROPOSER_ROLE();
            const data = tl.interface.encodeFunctionData("grantRole", [proposerRole, electionAdmin]);
            const salt = ethers.id("p8-test-salt");
            const delay = 2n * DAY;
            const noPredecessor = ethers.ZeroHash;

            await (await tl.connect(signer).schedule(target, 0, data, noPredecessor, salt, delay)).wait();
            const opId = await tl.hashOperation(target, 0, data, noPredecessor, salt);

            expect(await tl.isOperationPending(opId), "排程后应处于 pending").to.equal(true);
            expect(await tl.isOperationReady(opId), "未到期前不得为 ready").to.equal(false);

            // 未到期就提交执行：必须失败，否则时间锁形同虚设
            await expect(tl.connect(signer).execute(target, 0, data, noPredecessor, salt)).to.be.revertedWithCustomError(
                tl,
                "TimelockUnexpectedOperationState"
            );

            await time.increase(Number(delay) + 1);
            expect(await tl.isOperationReady(opId), "到期后应变为 ready").to.equal(true);

            expect(await tl.hasRole(proposerRole, electionAdmin)).to.equal(false);
            await (await tl.connect(signer).execute(target, 0, data, noPredecessor, salt)).wait();
            expect(await tl.hasRole(proposerRole, electionAdmin), "执行后角色应生效").to.equal(true);
            expect(await tl.isOperationDone(opId)).to.equal(true);
        });

        it("延时不足的排程被拒绝（不能借短延时绕过下限）", async function () {
            const T = await ethers.getContractFactory("Timelock");
            const tl = await T.deploy(2n * DAY, [deployerAddr], [ethers.ZeroAddress], ethers.ZeroAddress);
            await tl.waitForDeployment();
            const [signer] = await ethers.getSigners();
            const data = tl.interface.encodeFunctionData("grantRole", [
                await tl.PROPOSER_ROLE(),
                electionAdmin,
            ]);
            await expect(
                tl.connect(signer).schedule(await tl.getAddress(), 0, data, ethers.ZeroHash, ethers.id("x"), 60)
            ).to.be.revertedWithCustomError(tl, "TimelockInsufficientDelay");
        });
    });

    // ============================================================
    // 端到端冒烟
    // ============================================================
    describe("端到端冒烟（名册 → 经工厂创建提案）", function () {
        it("CREATOR_ROLE 经时间锁生效后，持有者才能创建提案", async function () {
            const factory = await ethers.getContractAt("ProposalFactory", dep.contracts.ProposalFactory.address);
            expect(await factory.hasRole(CREATOR_ROLE, electionAdmin)).to.equal(true);
            expect(dep.timelockOperations[0].state).to.equal("executed");
            expect(dep.smoke!.creator).to.equal(electionAdmin);
        });

        it("提案的 VERIFIER 是已部署的官方验证器（P4 移交的 P8 必做项）", async function () {
            const proposal = await ethers.getContractAt("Proposal", dep.smoke!.proposal);
            expect(await proposal.VERIFIER()).to.equal(dep.contracts.SemaphoreVerifier.address);
            expect(await proposal.REGISTRY()).to.equal(dep.smoke!.registry);
        });

        it("工厂编号与索引一致（INV-11 的部署侧体现）", async function () {
            const factory = await ethers.getContractAt("ProposalFactory", dep.contracts.ProposalFactory.address);
            const count: bigint = await factory.proposalCount();
            expect(count).to.equal(await factory.proposalsLength());
            expect(count).to.be.greaterThan(0n);
            for (let id = 1n; id <= count; id += 1n) {
                const addr = await factory.proposalOf(id);
                expect(await factory.proposalAt(id - 1n)).to.equal(addr);
                expect(await factory.isProposal(addr)).to.equal(true);
            }
        });

        it("未持有 CREATOR_ROLE 的账户调用 createProposal 必被拒绝", async function () {
            const signers = await ethers.getSigners();
            const factory = await ethers.getContractAt(
                "ProposalFactory",
                dep.contracts.ProposalFactory.address,
                signers[5]
            );
            const now = BigInt(await time.latest());

            await expect(
                factory.createProposal({
                    proposalId: 0n,
                    metadataCid: ethers.id("p8-denied"),
                    registry: dep.smoke!.registry,
                    verifier: dep.contracts.SemaphoreVerifier.address,
                    registrationEnd: now + 7200n,
                    votingStart: now + 14400n,
                    votingEnd: now + 28800n,
                    revealEnd: now + 28800n + 172800n,
                    optionCount: 4,
                    maxChoices: 2,
                })
            ).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");
        });
    });

    // ============================================================
    // 产物（DoD ③：浏览器可验证所需输入）
    // ============================================================
    describe("部署产物 deployments/<network>.json", function () {
        it("可序列化为 JSON（bigint 已转为十进制字符串，验证脚本可直接读取）", function () {
            const json = serializeDeployment(dep);
            const parsed = JSON.parse(json) as Record<string, unknown>;
            expect(parsed.network).to.equal("hardhat");
            expect(parsed.chainId).to.equal(31337);
            expect(parsed.contracts).to.have.property("ProposalFactory");
            expect(parsed.timelock).to.have.property("minDelay", DEFAULT_TIMELOCK_MIN_DELAY.toString());
        });

        it("每个合约都记录了构造参数与库地址 —— 源码验证的全部输入", function () {
            for (const [name, entry] of Object.entries(dep.contracts)) {
                expect(entry.address, `${name} 缺地址`).to.match(/^0x[0-9a-fA-F]{40}$/);
                expect(entry.txHash, `${name} 缺交易哈希`).to.match(/^0x[0-9a-fA-F]{64}$/);
                expect(entry.blockNumber, `${name} 缺区块号`).to.be.greaterThan(0);
                expect(Array.isArray(entry.constructorArgs), `${name} 构造参数应为数组`).to.equal(true);
            }
            // 含库链接的工厂必须写明库地址，否则浏览器验证必然失败
            expect(dep.contracts.ProposalFactory.libraries).to.deep.equal({
                PoseidonT4: dep.contracts.PoseidonT4.address,
            });
            // 时间锁的构造参数须逐位保留（数组 + uint256 + 地址）
            expect(dep.contracts.Timelock.constructorArgs[0]).to.equal(dep.timelock.minDelay);
            expect(dep.contracts.Timelock.constructorArgs[1]).to.deep.equal([dep.timelock.proposer]);
            expect(dep.contracts.Timelock.constructorArgs[2]).to.deep.equal([ethers.ZeroAddress]);
            expect(dep.contracts.Timelock.constructorArgs[3]).to.equal(ethers.ZeroAddress);
        });

        it("时间锁操作被完整记录（含固定 salt 与 operationId），供期满后执行", function () {
            const op = dep.timelockOperations[0];
            expect(op.signature).to.equal("grantRole(bytes32,address)");
            expect(op.target).to.equal(dep.contracts.ProposalFactory.address);
            expect(op.args[0]).to.equal(CREATOR_ROLE);
            expect(op.args[1]).to.equal(electionAdmin);
            expect(op.operationId).to.match(/^0x[0-9a-f]{64}$/);
            expect(op.salt).to.match(/^0x[0-9a-f]{64}$/);
        });
    });
});
