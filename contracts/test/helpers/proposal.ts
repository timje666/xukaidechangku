import { ethers } from "hardhat";

/**
 * 提案部署的共享夹具构造器。
 *
 * 【为什么需要它】
 * `ProposalInit` 是一个**跨阶段共享的结构体**：P3（状态机）、P4（ZK）、P5（中继）、
 * P7（Factory）都会构造它。它每增加一个必填字段，所有下游测试的 fixture 就会中断——
 * 这在 P4（加 `verifier`）与 P5（加 `forwarder`）已各发生一次。
 *
 * 各测试各自内联构造 init 是根因：字段定义分散在 N 处，改一处要改 N 处。
 * 因此统一收敛到本文件。**新增字段时只改这里**，下游测试自动跟进。
 *
 * 注意：这不改变 `ProposalInit` 本身的破坏性变更性质——若新字段无合理默认值，
 * 仍必须逐个调用方显式提供（此时 TS 编译错误会准确指出所有需要更新的位置，
 * 这正是我们希望的行为：宁可编译失败，也不要静默用错默认值）。
 */

const HOUR = 3600n;

/** 四段时间窗 */
export interface TimeWindows {
    now: bigint;
    registrationEnd: bigint;
    votingStart: bigint;
    votingEnd: bigint;
    revealEnd: bigint;
}

/**
 * 构造一组合法的四段时间窗。
 *
 * 【为什么每段都要留足余量，而不能贴着下限】
 * 两个独立的 1 秒偏移会叠加：
 *   ① `Params.validateTimeWindows` 校验的是 `registrationEnd - now_ >= MIN_REGISTRATION_WINDOW`，
 *      其中 `now_` 是**合约构造时的 block.timestamp**；
 *   ② Hardhat 每出一个块时间戳严格递增 —— 从读取 `time.latest()` 到部署交易落块，
 *      `block.timestamp` 至少前进 1 秒。
 * 因此若 `registrationEnd` 恰好等于下限，部署时会因差 1 秒被判非法
 * （P3 曾因此 34 项测试全部卡在构造器的 `InvalidTimeWindow`）。
 *
 * 本函数统一采用「数量级余量」：最短的登记期也有 2 小时，远大于 1 秒的偏移量。
 */
export function buildTimeWindows(now: bigint): TimeWindows {
    return {
        now,
        registrationEnd: now + 2n * HOUR,
        votingStart: now + 4n * HOUR,
        votingEnd: now + 8n * HOUR,
        revealEnd: now + 8n * HOUR + 48n * HOUR,
    };
}

/** `ProposalInit` 的构造输入 */
export interface ProposalInitInput extends TimeWindows {
    proposalId: bigint;
    registry: string;
    verifier: string;
    metadataCid?: string;
    optionCount?: number;
    maxChoices?: number;
}

/** 字段顺序需与 Solidity 侧 `ProposalInit` 的文件级 struct 声明一致 */
export function buildProposalInit(input: ProposalInitInput) {
    return {
        proposalId: input.proposalId,
        metadataCid: input.metadataCid ?? ethers.id("chainvote-meta"),
        registry: input.registry,
        verifier: input.verifier,
        registrationEnd: input.registrationEnd,
        votingStart: input.votingStart,
        votingEnd: input.votingEnd,
        revealEnd: input.revealEnd,
        optionCount: input.optionCount ?? 4,
        maxChoices: input.maxChoices ?? 2,
    };
}

/** 与 Semaphore 上游一致的标量哈希：`keccak256(abi.encodePacked(x)) >> 8` */
export function referenceHash(x: bigint): bigint {
    return BigInt(ethers.keccak256(ethers.solidityPacked(["uint256"], [x]))) >> 8n;
}

/** SNARK 标量域 */
export const SNARK_SCALAR_FIELD =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** 生成一个落在 SNARK 标量域内的确定性承诺值 */
export function commitmentFor(i: number | string): bigint {
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes(`cv-commit-${i}`))) % SNARK_SCALAR_FIELD;
}
