import { artifacts, ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { buildProposalInit, buildTimeWindows } from "../test/helpers/proposal";

/**
 * P8 部署核心 —— 可被脚本与测试共同调用的部署逻辑。
 *
 * 【为什么把逻辑与 CLI 分开】
 *   `deploy.ts` 只是「读环境变量 → 调本文件 → 写 JSON → 打印摘要」的薄壳。
 *   真正的部署顺序、接线自检、角色排程都在本文件里，因而可以**被测试直接调用**，
 *   在不启动外部节点、不打字命令的情况下验证全部不变量（见 test/p8.deploy.test.ts）。
 *   若把逻辑写在 `hardhat run` 的脚本体内，测试就只能靠「跑子进程 + 解析输出」间接验证。
 *
 * 【部署顺序（不可调整）】
 *   1. PoseidonT3（库）      —— VoterRegistry 的名册树依赖
 *   2. PoseidonT4（库）      —— Proposal 的选票承诺哈希依赖
 *   3. SemaphoreVerifier     —— ZK 验证器，无构造参数、无需链接
 *   4. Timelock              —— 治理时间锁，先于工厂，因为工厂要把它写进 immutable
 *   5. ProposalFactory       —— 传入 Timelock 作为初始管理员，并链接 PoseidonT4
 *   6. （可选）角色排程        —— CREATOR_ROLE 经时间锁「排程 → 等待 → 执行」
 *
 *   顺序依据见 scripts/check-link-references.mjs 的部署顺序要求，
 *   以及 docs/P4-Semaphore集成-交付记录.md §6.2（验证器不需要链接）。
 *
 * 【为什么地址是确定的（对应 P8 DoD「anvil 二次执行地址一致」）】
 *   全部合约都由**同一个账户**、按**固定顺序**以 CREATE 部署，不使用 CREATE2、
 *   不引入任何随机量（排程 salt 亦为固定常量）。因此每个地址都是 (deployer, nonce)
 *   的纯函数。本文件在部署前先用 `ethers.getCreateAddress` 预测地址，
 *   部署后逐一比对 —— 预测与实际不符立即失败。
 */

/** 本地开发链的 chainId（Hardhat = 31337，anvil/ganache 兼容 1337） */
export const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/** Timelock 最小延时的默认值：2 天，与 Timelock.MIN_TIMELOCK_DELAY 一致 */
export const DEFAULT_TIMELOCK_MIN_DELAY = 172800n;

/** 与 libs/Roles.sol 的 CREATOR_ROLE 必须一致（部署时用 roleName() 交叉校验） */
export const CREATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.CREATOR_ROLE"));

/** 排程用的固定 salt，使同一份配置产生同一个操作 id（地址与操作 id 均可复现） */
const GRANT_SALT = ethers.id("chainvote:grant:CREATOR_ROLE");

export interface DeployOptions {
    /** Timelock 操作最小延时（秒） */
    timelockMinDelay?: bigint;
    /** Timelock 的排程方。生产环境必须是多签地址；本地默认部署者 */
    proposer?: string;
    /** Timelock 的执行方数组；默认 [零地址]，表示任何人可执行 */
    executors?: string[];
    /** Timelock 的无延时管理员；默认零地址（自管理） */
    admin?: string;
    /** 获得 CREATOR_ROLE 的选举管理员地址；为空则跳过排程 */
    electionAdmin?: string;
    /** 排程后是否快进并执行（仅本地链有意义） */
    fastForward?: boolean;
    /** 是否执行部署后冒烟测试 */
    smoke?: boolean;
}

export interface ContractEntry {
    address: string;
    txHash: string;
    blockNumber: number;
    gasUsed: string;
    constructorArgs: unknown[];
    libraries: Record<string, string>;
}

export interface CheckEntry {
    name: string;
    ok: boolean;
    detail: string;
}

export interface TimelockOperation {
    operationId: string;
    target: string;
    signature: string;
    args: unknown[];
    data: string;
    salt: string;
    eta: string;
    state: "scheduled" | "executed" | "not-scheduled";
    note?: string;
}

export interface SmokeResult {
    registry: string;
    proposalId: string;
    proposal: string;
    creator: string;
    checks: CheckEntry[];
}

export interface Deployment {
    network: string;
    chainId: number;
    deployer: string;
    /** 部署起始 nonce：第一个合约（PoseidonT3）的 CREATE nonce。
     *  地址由 (deployer, nonce) 复现；该字段使测试无需假设「从 0 开始」，
     *  在完整测试套件中其他文件已消耗部分 nonce 时仍能正确验收地址确定性。 */
    deployNonce0: number;
    deployedAt: string;
    timelock: {
        minDelay: string;
        proposer: string;
        executors: string[];
        admin: string;
        selfAdministered: boolean;
    };
    contracts: Record<string, ContractEntry>;
    checks: CheckEntry[];
    timelockOperations: TimelockOperation[];
    smoke?: SmokeResult;
}

/** 需要部署的合约，顺序即部署顺序（地址预测依赖此顺序） */
export const DEPLOY_ORDER = [
    "PoseidonT3",
    "PoseidonT4",
    "SemaphoreVerifier",
    "Timelock",
    "ProposalFactory",
] as const;

/** 本地链的默认配置；生产链必须由环境变量显式提供 proposer */
export function resolveConfigFromEnv(
    networkName: string,
    chainId: number,
    deployer: string,
    localAdminCandidate?: string
): DeployOptions {
    const isLocal = LOCAL_CHAIN_IDS.has(chainId);
    const minDelay = BigInt(process.env.TIMELOCK_MIN_DELAY ?? DEFAULT_TIMELOCK_MIN_DELAY.toString());
    const proposer = process.env.TIMELOCK_PROPOSER ?? (isLocal ? deployer : "");
    const executors = process.env.TIMELOCK_EXECUTOR
        ? [process.env.TIMELOCK_EXECUTOR]
        : [ethers.ZeroAddress];
    const admin = process.env.TIMELOCK_ADMIN ?? ethers.ZeroAddress;
    const electionAdmin = process.env.ELECTION_ADMIN ?? (isLocal ? (localAdminCandidate ?? "") : "");

    if (!proposer) {
        throw new Error(
            `非本地网络（${networkName}，chainId=${chainId}）必须显式提供 TIMELOCK_PROPOSER。\n` +
                "  理由：排程权若默认落到部署者 EOA，部署者将长期持有一项治理权限；\n" +
                "        生产环境应为多签地址（如 Safe），由多人共同排程角色变更。"
        );
    }

    const flag = (v: string | undefined, dflt: boolean) =>
        v === undefined || v === "" ? dflt : v === "true" || v === "1";

    return {
        timelockMinDelay: minDelay,
        proposer,
        executors,
        admin,
        electionAdmin,
        fastForward: flag(process.env.FAST_FORWARD, isLocal),
        smoke: flag(process.env.SMOKE, isLocal),
    };
}

/** 读部署者 nonce（pending），用于 CREATE 地址预测 */
async function deployerNonce(address: string): Promise<number> {
    return Number(await ethers.provider.getTransactionCount(address, "pending"));
}

/**
 * 校验已部署字节码里的库链接槽确实指向给定库地址。
 *
 * 【为什么不能直接读 artifact 的 deployedBytecode】
 *   artifact 里的字节码仍是**未链接**形态：库地址位置全是 30 个零（占位符）。
 *   只有真正部署出来的字节码才会被 Hardhat 填入库地址。
 *   若只断言「部署成功了」，一个把库链接到错误地址的 bug 仍然能通过 ——
 *   本函数直接比对**运行时字节码的链接槽**，使链接错误无法隐藏。
 *
 * 【★必须用 `deployedLinkReferences`，不是 `linkReferences`】
 *   二者是两份不同的偏移表：`linkReferences` 对应**创建码**（initcode），
 *   `deployedLinkReferences` 才是**运行时代码**。用错表会读到完全无关的字节窗口，
 *   报出「偏移 9726 处不是库地址」这类看似链接失败的假警报。
 */
async function assertLibrariesLinked(
    contractName: string,
    deployedCode: string,
    libraries: Record<string, string>
): Promise<string> {
    const art = (await artifacts.readArtifact(contractName)) as unknown as {
        deployedLinkReferences?: Record<string, Record<string, { start: number; length: number }[]>>;
        linkReferences?: Record<string, Record<string, { start: number; length: number }[]>>;
    };
    const refs = art.deployedLinkReferences ?? art.linkReferences ?? {};
    const code = deployedCode.toLowerCase().replace(/^0x/, "");
    const seen: string[] = [];

    for (const [srcFile, libsInFile] of Object.entries(refs)) {
        for (const [libName, positions] of Object.entries(libsInFile)) {
            const addr = libraries[libName];
            if (!addr) {
                throw new Error(`${contractName} 缺少库 ${libName}（来源 ${srcFile}）的链接地址`);
            }
            const expected = addr.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
            for (const { start, length } of positions) {
                const actual = code.slice(start * 2, (start + length) * 2).replace(/^0+/, "");
                if (actual !== expected) {
                    throw new Error(
                        `${contractName} 的库 ${libName} 未正确链接：` +
                            `字节码偏移 ${start} 处为 0x${actual || "<全零>"}，期望 ${addr}`
                    );
                }
            }
            seen.push(libName);
        }
    }
    return seen.length > 0 ? `已链接 ${[...new Set(seen)].join("、")}` : "无需链接";
}

/** 部署一个合约并返回产物 + 合约实例 */
async function deployOne(
    name: string,
    ctorArgs: unknown[],
    libraries: Record<string, string> = {}
): Promise<{ entry: ContractEntry; contract: any }> {
    const factory = await ethers.getContractFactory(name, { libraries });
    const contract = await factory.deploy(...(ctorArgs as never[]));
    const tx = contract.deploymentTransaction();
    const receipt = await tx?.wait();
    return {
        contract,
        entry: {
            address: await contract.getAddress(),
            txHash: tx?.hash ?? "",
            blockNumber: receipt?.blockNumber ?? 0,
            gasUsed: (receipt?.gasUsed ?? 0n).toString(),
            constructorArgs: ctorArgs,
            libraries,
        },
    };
}

/** 执行完整部署 + 接线自检 + 角色排程（+ 可选冒烟） */
export async function deployAll(opts: DeployOptions = {}): Promise<Deployment> {
    const signers = await ethers.getSigners();
    if (signers.length === 0) throw new Error("没有可用签名账户：请检查 DEPLOYER_PK 或本地网络配置");

    const deployer = signers[0];
    const deployerAddr = await deployer.getAddress();
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const isLocal = LOCAL_CHAIN_IDS.has(chainId);

    const minDelay = opts.timelockMinDelay ?? DEFAULT_TIMELOCK_MIN_DELAY;
    const proposer = opts.proposer ?? deployerAddr;
    const executors = opts.executors ?? [ethers.ZeroAddress];
    const admin = opts.admin ?? ethers.ZeroAddress;
    const electionAdmin = opts.electionAdmin ?? "";
    const fastForward = opts.fastForward ?? false;
    const smokeRequested = opts.smoke ?? false;

    const checks: CheckEntry[] = [];
    const record = (name: string, ok: boolean, detail: string) => {
        checks.push({ name, ok, detail });
        return ok;
    };

    // ---------- 地址预测（确定性验收的第一道） ----------
    const nonce0 = await deployerNonce(deployerAddr);
    const predict = (i: number) =>
        ethers.getCreateAddress({ from: deployerAddr, nonce: nonce0 + i }).toLowerCase();

    // 1) 库 → 2) 验证器 → 3) 时间锁 → 4) 工厂
    const pt3 = await deployOne("PoseidonT3", []);
    const pt4 = await deployOne("PoseidonT4", []);
    const verifier = await deployOne("SemaphoreVerifier", []);
    const timelock = await deployOne("Timelock", [minDelay, [proposer], executors, admin]);
    const factory = await deployOne("ProposalFactory", [timelock.entry.address], {
        PoseidonT4: pt4.entry.address,
    });

    const contracts: Record<string, ContractEntry> = {
        PoseidonT3: pt3.entry,
        PoseidonT4: pt4.entry,
        SemaphoreVerifier: verifier.entry,
        Timelock: timelock.entry,
        ProposalFactory: factory.entry,
    };

    DEPLOY_ORDER.forEach((name, i) => {
        const c = contracts[name];
        record(
            `地址确定性 · ${name}`,
            c.address.toLowerCase() === predict(i),
            `实际 ${c.address}，按 CREATE(deployer, nonce=${nonce0 + i}) 预测 ${predict(i)}`
        );
    });

    // ---------- 接线自检 ----------
    const factoryAddr = factory.entry.address;
    const timelockAddr = timelock.entry.address;
    const tl = timelock.contract;
    const fc = factory.contract;

    const onChainMinDelay: bigint = await tl.getMinDelay();
    const minDelayFloor: bigint = await tl.MIN_TIMELOCK_DELAY();
    record(
        "Timelock 延时不低于合约下限",
        onChainMinDelay >= minDelayFloor,
        `minDelay=${onChainMinDelay}s，下限=${minDelayFloor}s（${Number(minDelayFloor) / 86400} 天）`
    );
    record(
        "Timelock 自管理（无 EOA 无延时管理员）",
        (await tl.hasRole(ethers.ZeroHash, timelockAddr)) && !(await tl.hasRole(ethers.ZeroHash, deployerAddr)),
        `DEFAULT_ADMIN_ROLE: Timelock=${await tl.hasRole(ethers.ZeroHash, timelockAddr)}，` +
            `deployer=${await tl.hasRole(ethers.ZeroHash, deployerAddr)}`
    );

    const proposalAdmin: string = await fc.PROPOSAL_ADMIN();
    record(
        "工厂的 PROPOSAL_ADMIN 为 Timelock",
        proposalAdmin.toLowerCase() === timelockAddr.toLowerCase(),
        `PROPOSAL_ADMIN=${proposalAdmin}，Timelock=${timelockAddr}`
    );
    record(
        "工厂的 DEFAULT_ADMIN_ROLE 为 Timelock",
        (await fc.hasRole(ethers.ZeroHash, timelockAddr)) && !(await fc.hasRole(ethers.ZeroHash, deployerAddr)),
        `Timelock=${await fc.hasRole(ethers.ZeroHash, timelockAddr)}，` +
            `deployer=${await fc.hasRole(ethers.ZeroHash, deployerAddr)}`
    );
    record(
        "部署者无任何业务角色",
        !(await fc.hasRole(CREATOR_ROLE, deployerAddr)),
        `deployer 的 CREATOR_ROLE=${await fc.hasRole(CREATOR_ROLE, deployerAddr)}（应为 false）`
    );
    record(
        "CREATOR_ROLE 常量与链上角色名一致",
        (await fc.roleName(CREATOR_ROLE)) === "CREATOR_ROLE",
        `roleName(${CREATOR_ROLE.slice(0, 10)}…) = ${await fc.roleName(CREATOR_ROLE)}`
    );

    // 验证器必须是官方实现，不得是测试替身（P4 交付记录 §3.3 的 P8 必做项）
    const verifierCode: string = await ethers.provider.getCode(verifier.entry.address);
    const realVerifier = await artifacts.readArtifact("SemaphoreVerifier");
    record(
        "验证器为官方 SemaphoreVerifier（非测试替身）",
        verifierCode === realVerifier.deployedBytecode,
        `部署字节码 ${verifierCode.length / 2 - 1} B，与官方实现逐字节一致=${verifierCode === realVerifier.deployedBytecode}`
    );

    const pt4Link = await assertLibrariesLinked(
        "ProposalFactory",
        await ethers.provider.getCode(factoryAddr),
        { PoseidonT4: pt4.entry.address }
    );
    record("PoseidonT4 已链接进工厂字节码", pt4Link.includes("PoseidonT4"), pt4Link);

    // ---------- 角色排程（CREATOR_ROLE 经时间锁） ----------
    const timelockOperations: TimelockOperation[] = [];
    const grantData = fc.interface.encodeFunctionData("grantRole", [CREATOR_ROLE, electionAdmin]);
    const opId: string = await tl.hashOperation(factoryAddr, 0, grantData, ethers.ZeroHash, GRANT_SALT);
    const proposerSigner = signers.find((s) => s.address.toLowerCase() === proposer.toLowerCase());

    if (!electionAdmin) {
        timelockOperations.push({
            operationId: opId,
            target: factoryAddr,
            signature: "grantRole(bytes32,address)",
            args: [CREATOR_ROLE, "<未配置 ELECTION_ADMIN>"],
            data: grantData,
            salt: GRANT_SALT,
            eta: "0",
            state: "not-scheduled",
            note: "未提供 ELECTION_ADMIN，跳过排程。补做方式见交付记录 §运维手册",
        });
    } else if (!proposerSigner) {
        timelockOperations.push({
            operationId: opId,
            target: factoryAddr,
            signature: "grantRole(bytes32,address)",
            args: [CREATOR_ROLE, electionAdmin],
            data: grantData,
            salt: GRANT_SALT,
            eta: "0",
            state: "not-scheduled",
            note: `排程方 ${proposer} 不是本地签名账户（如多签），需由其自行排程；operationId 已预先算出`,
        });
    } else {
        await (
            await tl
                .connect(proposerSigner)
                .schedule(factoryAddr, 0, grantData, ethers.ZeroHash, GRANT_SALT, minDelay)
        ).wait();
        let state: TimelockOperation["state"] = "scheduled";
        let eta = (BigInt(await time.latest()) + minDelay).toString();

        if (fastForward) {
            // 仅本地链：快进到可执行时刻并立即执行，使本地环境处于「已配置」状态
            await time.increase(Number(minDelay) + 1);
            await (
                await tl
                    .connect(proposerSigner)
                    .execute(factoryAddr, 0, grantData, ethers.ZeroHash, GRANT_SALT)
            ).wait();
            state = "executed";
            eta = String(await time.latest());
        }

        const granted: boolean = await fc.hasRole(CREATOR_ROLE, electionAdmin);
        record(
            state === "executed"
                ? "CREATOR_ROLE 已经时间锁授予选举管理员"
                : "CREATOR_ROLE 已排程（等待期满后执行）",
            state === "executed" ? granted : true,
            `electionAdmin=${electionAdmin}，hasRole(CREATOR_ROLE)=${granted}，operationId=${opId}`
        );

        timelockOperations.push({
            operationId: opId,
            target: factoryAddr,
            signature: "grantRole(bytes32,address)",
            args: [CREATOR_ROLE, electionAdmin],
            data: grantData,
            salt: GRANT_SALT,
            eta,
            state,
            note:
                state === "executed"
                    ? "本地链已快进执行"
                    : `等待满 ${Number(minDelay) / 3600} 小时后由执行方提交`,
        });
    }

    // ---------- 冒烟测试（可选） ----------
    let smoke: SmokeResult | undefined;
    if (smokeRequested) {
        const grantedNow: boolean = electionAdmin ? await fc.hasRole(CREATOR_ROLE, electionAdmin) : false;
        if (!grantedNow) {
            record(
                "冒烟测试",
                true,
                "跳过：CREATOR_ROLE 尚未生效（时间锁延时中）。期满后重跑本脚本或设 SMOKE=true 即可"
            );
        } else {
            const tw = buildTimeWindows(BigInt(await time.latest()));
            const R = await ethers.getContractFactory("VoterRegistry", {
                libraries: { PoseidonT3: pt3.entry.address },
            });
            const registry = await R.deploy(timelockAddr, tw.registrationEnd);
            await registry.waitForDeployment();
            const registryAddr = await registry.getAddress();

            const pt3Link = await assertLibrariesLinked(
                "VoterRegistry",
                await ethers.provider.getCode(registryAddr),
                { PoseidonT3: pt3.entry.address }
            );
            record("PoseidonT3 已链接进名册字节码", pt3Link.includes("PoseidonT3"), pt3Link);

            const creator = signers.find((s) => s.address.toLowerCase() === electionAdmin.toLowerCase());
            const creatorAddr = creator ? creator.address : deployerAddr;

            await (
                await fc.connect(creator ?? deployer).createProposal(
                    buildProposalInit({
                        proposalId: 0n, // 工厂统一分配
                        registry: registryAddr,
                        verifier: verifier.entry.address,
                        ...tw,
                    })
                )
            ).wait();

            const pid: bigint = await fc.proposalCount();
            const proposalAddr: string = await fc.proposalOf(pid);
            const proposal = await ethers.getContractAt("Proposal", proposalAddr);

            const smokeChecks: CheckEntry[] = [];
            const srec = (name: string, ok: boolean, detail: string) => {
                smokeChecks.push({ name, ok, detail });
                checks.push({ name: `冒烟 · ${name}`, ok, detail });
            };

            const proposalVerifier: string = await proposal.VERIFIER();
            srec(
                "提案的 VERIFIER 为已部署的官方验证器",
                proposalVerifier.toLowerCase() === verifier.entry.address.toLowerCase(),
                `Proposal.VERIFIER=${proposalVerifier}，期望 ${verifier.entry.address}`
            );
            srec(
                "提案的 REGISTRY 与本次部署的名册一致",
                (await proposal.REGISTRY()).toLowerCase() === registryAddr.toLowerCase(),
                `Proposal.REGISTRY=${await proposal.REGISTRY()}`
            );
            srec(
                "工厂索引可反查该提案",
                (await fc.isProposal(proposalAddr)) &&
                    (await fc.proposalAt(pid - 1n)) === proposalAddr,
                `proposalCount=${pid}，isProposal=${await fc.isProposal(proposalAddr)}`
            );
            srec(
                "提案编号由工厂分配（1 起）",
                pid === 1n && (await proposal.PROPOSAL_ID()) === 1n,
                `proposalCount=${pid}，PROPOSAL_ID=${await proposal.PROPOSAL_ID()}`
            );

            smoke = {
                registry: registryAddr,
                proposalId: pid.toString(),
                proposal: proposalAddr,
                creator: creatorAddr,
                checks: smokeChecks,
            };
        }
    }

    // ---------- 汇总 ----------
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
        throw new Error(
            `部署后自检未通过（${failed.length}/${checks.length} 项失败）：\n` +
                failed.map((c) => `  ✗ ${c.name} —— ${c.detail}`).join("\n")
        );
    }

    return {
        network: network.name,
        chainId,
        deployer: deployerAddr,
        deployNonce0: nonce0,
        deployedAt: new Date().toISOString(),
        timelock: {
            minDelay: minDelay.toString(),
            proposer,
            executors,
            admin,
            selfAdministered: admin === ethers.ZeroAddress,
        },
        contracts,
        checks,
        timelockOperations,
        smoke,
    };
}

/** 序列化（bigint → 十进制字符串），保证 JSON 可读且两次运行可逐字段比对 */
export function serializeDeployment(dep: Deployment): string {
    return JSON.stringify(dep, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
