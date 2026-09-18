// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";

import {ChainVoteAccessControl} from "../access/ChainVoteAccessControl.sol";
import {Params} from "../libs/Params.sol";
import {BallotCodec} from "../libs/BallotCodec.sol";
import "../libs/Errors.sol";

/// @notice 揭示期输入：明文选票
/// @param ballotCommitment 投票期已上链的选票承诺
/// @param ballotMask 选票位图，bit i = 1 表示选中第 i 个选项
/// @param salt 生成承诺时使用的随机盐
struct RevealPayload {
    bytes32 ballotCommitment;
    uint16 ballotMask;
    uint256 salt;
}

/// @notice 提案初始化参数
/// @dev 置于文件级而非合约内，便于 `ProposalHarness` 与后续的 `ProposalFactory` 复用。
///      字段按「32 字节对齐优先」排列以减少存储槽占用（当前仅用作构造参数，
///      但保持紧凑可在后续被 Factory 落库时直接受益）。
/// @param proposalId 提案编号（全局唯一，由 Factory 分配）
/// @param metadataCid IPFS 元数据 CID
/// @param registry 名册合约地址
/// @param registrationEnd 登记期结束时刻
/// @param votingStart 投票期开始时刻
/// @param votingEnd 投票期结束时刻（揭示期开始）
/// @param revealEnd 揭示期结束时刻（此后可封存）
/// @param optionCount 选项数（2–16）
/// @param maxChoices 每人最多可选数（1–8）
struct ProposalInit {
    uint256 proposalId;
    bytes32 metadataCid;
    address registry;
    uint64 registrationEnd;
    uint64 votingStart;
    uint64 votingEnd;
    uint64 revealEnd;
    uint8 optionCount;
    uint8 maxChoices;
}

/// @title Proposal —— 单场提案的四阶段状态机
/// @notice 一个提案一个合约实例（N5）。承担：
///         投票期记录承诺 → 揭示期校验明文并计票 → 揭示期结束后封存结果哈希。
///
/// @dev 设计要点与依据：
///
///      **1. 阶段只由 `block.timestamp` 推导，无任何管理员干预接口（N3 / 冻结 Q4）**
///      不存在 `pause` / `extend` / `earlyClose` / `setPhase`。
///      五个分支对应 `REGISTRATION → IDLE → VOTING → REVEAL → CLOSED → FINALIZED`。
///      `IDLE` 与 `CLOSED` 是评审 F-01 的修正产物：前者消除「空档期仍可登记」的歧义，
///      后者区分「已过揭示窗口但尚未封存」与「已封存」。
///
///      **2. 时窗守卫一律直接比较时间戳，禁用 `phase()`（F-01 同类风险）**
///      `_recordBallot` 与 `reveal` 各自直接比较 `VOTING_START / VOTING_END / REVEAL_END`。
///      若改用 `phase() == VOTING` 之类判断，空档期语义一旦调整就会产生新的可写窗口。
///
///      **3. 选票承诺带提案域分隔（隐私增强）**
///      `ballotCommitment = Poseidon4([ballotMask, salt, SCOPE])`，
///      其中 `SCOPE = H(SCOPE_DOMAIN, chainId, address(this))` 全局唯一。
///      这防止「同一选民在不同提案复用同一 salt 时，其承诺在不同提案间可被关联」——
///      没有域分隔时，观察者用 A 提案揭示出的 (mask, salt) 去比对 B 提案的承诺集合，
///      命中即可判定两票属于同一人。
///
///      **4. 揭示期不 revert 而是标记作废（错误质量优先）**
///      单条揭示若因选择超限被拒，**不 revert 整批**，而是标记 `REJECTED` 并计入
///      `rejectedCount`。否则一条坏票会让同批其余所有票都无法揭示。
///      被拒的承诺会被标记，**不可重试**（防止反复空耗 gas）。
///
///      **5. P3 阶段刻意不暴露 `castVote`**
///      投票路径 `_recordBallot` 在 P3 为 `internal`，仅由 P4 的角色化 `castVote`（带 ZK 校验）
///      调用。**不提供「不带证明校验的 external 入口」**——即便只是过渡版本，
///      也不让一个「任何人可投票」的外部函数出现在可部署合约里。
///      P3 的全部状态机行为通过 `ProposalHarness` 测试。
///
/// @author ChainVote
contract Proposal is ChainVoteAccessControl {
    // ============================================================
    // 类型
    // ============================================================

    /// @notice 提案阶段。顺序即时间推进方向，不可回退（INV-5）
    enum Phase {
        REGISTRATION,
        IDLE,
        VOTING,
        REVEAL,
        CLOSED,
        FINALIZED
    }

    /// @notice 单个承诺的揭示处理状态
    enum RevealStatus {
        NONE,
        ACCEPTED,
        REJECTED
    }

    // ============================================================
    // 不可变配置
    // ============================================================

    /// @notice 提案编号（全局唯一）
    uint256 public immutable PROPOSAL_ID;
    /// @notice 名册合约地址。投票期取冻结根时使用
    address public immutable REGISTRY;
    /// @notice IPFS 元数据 CID
    bytes32 public immutable METADATA_CID;

    /// @notice 登记期结束时刻
    uint64 public immutable REGISTRATION_END;
    /// @notice 投票期开始时刻
    uint64 public immutable VOTING_START;
    /// @notice 投票期结束时刻（揭示期开始）
    uint64 public immutable VOTING_END;
    /// @notice 揭示期结束时刻（此后可封存）
    uint64 public immutable REVEAL_END;

    /// @notice 选项数
    uint8 public immutable OPTION_COUNT;
    /// @notice 每人最多可选数
    uint8 public immutable MAX_CHOICES;

    /// @notice 本提案的 ZK scope，同时用作选票承诺的域分隔
    uint256 public immutable SCOPE;

    // ============================================================
    // 状态
    // ============================================================

    uint64[16] private _counts;

    /// @notice 已提交的承诺数（= 参与投票人数）
    uint64 public nullifierCount;
    /// @notice 已成功揭示的票数
    uint64 public revealedCount;
    /// @notice 被作废的揭示数（选择超限或位图越界）
    uint64 public rejectedCount;
    /// @notice 选中项累计数，供 INV-1 断言
    uint64 public totalMarks;

    /// @notice 是否已封存。封存后票数不可再变（INV-6）
    bool public finalized;
    /// @notice 结果哈希。仅当 `finalized` 为 true 时有意义
    bytes32 public resultHash;

    mapping(uint256 => bool) private _nullifierUsed;
    mapping(bytes32 => bool) private _commitmentCast;
    mapping(bytes32 => RevealStatus) private _revealStatus;

    // ============================================================
    // 事件
    // ============================================================

    /// @notice 一张选票承诺已上链
    /// @param proposalId 提案编号
    /// @param nullifier 选民假名（由 ZK 电路派生，无法映射回身份）
    /// @param ballotCommitment 选票承诺，**不含选项明文**
    /// @param commitIndex 第几个提交（0 起）
    event BallotCommitted(
        uint256 indexed proposalId,
        uint256 indexed nullifier,
        bytes32 ballotCommitment,
        uint64 commitIndex
    );

    /// @notice 一张选票已完成揭示并计入
    /// @param proposalId 提案编号
    /// @param ballotCommitment 已揭示的承诺
    /// @param revealedCount 揭示后的累计有效票数
    event BallotRevealed(uint256 indexed proposalId, bytes32 indexed ballotCommitment, uint64 revealedCount);

    /// @notice 一张选票在揭示时被判废
    /// @param proposalId 提案编号
    /// @param ballotCommitment 被作废的承诺
    /// @param reason 作废原因码（见 `Params.REASON_*`）
    event RevealRejected(uint256 indexed proposalId, bytes32 indexed ballotCommitment, uint8 reason);

    /// @notice 提案已封存，结果锁定
    /// @param proposalId 提案编号
    /// @param counts 各选项最终得票
    /// @param revealedCount 有效票数
    /// @param nullifierCount 参与人数
    /// @param rejectedCount 作废票数
    /// @param resultHash 结果哈希，任何人可据此离线复算
    /// @param finalizedAt 封存时间戳
    event ProposalFinalized(
        uint256 indexed proposalId,
        uint64[16] counts,
        uint64 revealedCount,
        uint64 nullifierCount,
        uint64 rejectedCount,
        bytes32 resultHash,
        uint64 finalizedAt
    );

    // ============================================================
    // 构造
    // ============================================================

    /// @notice 部署提案
    /// @param initialAdmin 初始管理员（生产环境为 Timelock）
    /// @param init 提案初始化参数，创建时校验并冻结
    constructor(address initialAdmin, ProposalInit memory init) ChainVoteAccessControl(initialAdmin) {
        if (init.registry == address(0)) revert ZeroAddress();
        if (!Params.validateOptions(init.optionCount, init.maxChoices)) revert InvalidOptionCount();
        if (
            !Params.validateTimeWindows(
                uint64(block.timestamp),
                init.registrationEnd,
                init.votingStart,
                init.votingEnd,
                init.revealEnd
            )
        ) {
            revert InvalidTimeWindow();
        }

        PROPOSAL_ID = init.proposalId;
        REGISTRY = init.registry;
        METADATA_CID = init.metadataCid;
        REGISTRATION_END = init.registrationEnd;
        VOTING_START = init.votingStart;
        VOTING_END = init.votingEnd;
        REVEAL_END = init.revealEnd;
        OPTION_COUNT = init.optionCount;
        MAX_CHOICES = init.maxChoices;
        SCOPE = Params.scopeOf(block.chainid, address(this));
    }

    // ============================================================
    // 阶段
    // ============================================================

    /// @notice 当前阶段，完全由 `block.timestamp` 推导
    /// @dev 【硬约束】本合约不存在任何可改变阶段的写接口
    /// @return 当前阶段枚举值
    function phase() public view returns (Phase) {
        if (block.timestamp < REGISTRATION_END) return Phase.REGISTRATION;
        if (block.timestamp < VOTING_START) return Phase.IDLE;
        if (block.timestamp < VOTING_END) return Phase.VOTING;
        if (block.timestamp < REVEAL_END) return Phase.REVEAL;
        return finalized ? Phase.FINALIZED : Phase.CLOSED;
    }

    // ============================================================
    // 投票期：记录承诺
    // ============================================================

    /// @notice 记录一张选票承诺
    /// @dev **P3 阶段为 `internal`**：仅由 P4 的 `castVote`（带 ZK 证明校验）调用。
    ///      刻意不提供无证明校验的 external 入口，避免过渡版本出现「任何人可投票」的合约。
    ///
    /// @dev 【硬约束】时窗判断直接比较 `block.timestamp`，**禁止使用 `phase()`**（F-01）
    ///
    /// @param nullifier 选民假名，由 ZK 电路派生；同一提案内唯一
    /// @param ballotCommitment 选票承诺，投票期上链的唯一内容
    function _recordBallot(uint256 nullifier, bytes32 ballotCommitment) internal {
        if (block.timestamp < VOTING_START) revert VotingNotOpen();
        if (block.timestamp >= VOTING_END) revert VotingClosed();

        if (ballotCommitment == bytes32(0)) revert ZeroCommitment();
        if (_nullifierUsed[nullifier]) revert AlreadyVoted();
        if (_commitmentCast[ballotCommitment]) revert CommitmentAlreadyCast();

        _nullifierUsed[nullifier] = true;
        _commitmentCast[ballotCommitment] = true;

        uint64 index = nullifierCount;
        ++nullifierCount;

        emit BallotCommitted(PROPOSAL_ID, nullifier, ballotCommitment, index);
    }

    // ============================================================
    // 揭示期：校验明文并计票
    // ============================================================

    /// @notice 批量揭示。**任何人可调用**，无需是选民本人
    /// @dev 单条失败不 revert 整批（选择超限/位图越界仅作废该条），
    ///      以保证一条坏票不会阻断同批其余票的揭示
    /// @param payloads 揭示载荷数组
    function reveal(RevealPayload[] calldata payloads) external {
        if (block.timestamp < VOTING_END) revert RevealNotOpen();
        if (block.timestamp >= REVEAL_END) revert RevealClosed();

        uint256 n = payloads.length;
        if (n == 0 || n > Params.MAX_REVEAL_BATCH) revert BatchTooLarge();

        for (uint256 i = 0; i < n; ++i) {
            _revealOne(payloads[i]);
        }
    }

    /// @dev 单条揭示的校验顺序（F-02 关键防护，顺序不可调整）：
    ///      ① 票据存在性 —— 该承诺确曾在投票期上链。**缺此检查即可凭空造票。**
    ///      ② 未处理过 —— 防止重复揭示与失败后反复重试
    ///      ③ 明文匹配 —— Poseidon 承诺校验（含提案域分隔）
    ///      ④ 选项合规 —— 位图越界与选择超限，违规即标记作废
    ///      ⑤ 累计票数
    function _revealOne(RevealPayload calldata p) internal {
        bytes32 c = p.ballotCommitment;

        // ① 【F-02】票据存在性绑定 —— 禁止删除本行
        if (!_commitmentCast[c]) revert CommitmentNotCast();

        // ② 未处理过
        if (_revealStatus[c] != RevealStatus.NONE) revert AlreadyRevealed();

        // ③ 明文与承诺匹配
        if (bytes32(PoseidonT4.hash([uint256(p.ballotMask), p.salt, SCOPE])) != c) {
            revert CommitmentMismatch();
        }

        // ④ 选项合规：先判越界，再判选择数，以便给出准确的原因码
        if (OPTION_COUNT < Params.MAX_OPTION_COUNT && p.ballotMask >> OPTION_COUNT != 0) {
            _reject(c, Params.REASON_MASK_OUT_OF_RANGE);
            return;
        }
        if (!BallotCodec.validate(p.ballotMask, OPTION_COUNT, MAX_CHOICES)) {
            _reject(c, Params.REASON_CHOICE_LIMIT);
            return;
        }

        // ⑤ 累计
        _revealStatus[c] = RevealStatus.ACCEPTED;
        totalMarks += BallotCodec.popcount(p.ballotMask);

        for (uint8 i = 0; i < OPTION_COUNT; ++i) {
            if (BallotCodec.isPicked(p.ballotMask, i)) {
                ++_counts[i];
            }
        }

        ++revealedCount;
        emit BallotRevealed(PROPOSAL_ID, c, revealedCount);
    }

    /// @dev 标记承诺作废。**不 revert**，以便批量揭示继续；
    ///      同时写入 REJECTED 状态，使该承诺不可被反复重试
    function _reject(bytes32 c, uint8 reason) internal {
        _revealStatus[c] = RevealStatus.REJECTED;
        ++rejectedCount;
        emit RevealRejected(PROPOSAL_ID, c, reason);
    }

    // ============================================================
    // 封存
    // ============================================================

    /// @notice 揭示窗口结束后封存结果。**任何人可调用，幂等**
    /// @dev `finalize` 不做任何遍历，成本为 O(optionCount)
    function finalize() external {
        if (block.timestamp < REVEAL_END) revert RevealWindowOpen();
        if (finalized) revert AlreadyFinalized();

        finalized = true;

        uint64[16] memory counts = _counts;
        bytes32 h = keccak256(
            abi.encode(
                Params.RESULT_HASH_DOMAIN,
                block.chainid,
                address(this),
                PROPOSAL_ID,
                counts,
                revealedCount,
                nullifierCount,
                rejectedCount
            )
        );
        resultHash = h;

        emit ProposalFinalized(
            PROPOSAL_ID,
            counts,
            revealedCount,
            nullifierCount,
            rejectedCount,
            h,
            uint64(block.timestamp)
        );
    }

    // ============================================================
    // 查询
    // ============================================================

    /// @notice 取各选项得票数
    /// @dev 【硬约束 3】封存前必须 revert。`_counts` 的原始存储客观上可被直接读取，
    ///      这是公开链的固有限制；接口层必须统一表现为「计票中」
    /// @return 长度固定为 16 的得票数组，仅前 `OPTION_COUNT` 项有意义
    function getCounts() external view returns (uint64[16] memory) {
        if (!finalized) revert ResultLocked();
        return _counts;
    }

    /// @notice 取结果哈希，封存前 revert
    /// @return 结果哈希
    function getResultHash() external view returns (bytes32) {
        if (!finalized) revert ResultLocked();
        return resultHash;
    }

    /// @notice 该假名是否已投过票
    /// @param nullifier 选民假名
    /// @return 已投票返回 true
    function isNullifierUsed(uint256 nullifier) external view returns (bool) {
        return _nullifierUsed[nullifier];
    }

    /// @notice 该承诺是否曾在投票期上链
    /// @param ballotCommitment 选票承诺
    /// @return 已上链返回 true
    function isCommitmentCast(bytes32 ballotCommitment) external view returns (bool) {
        return _commitmentCast[ballotCommitment];
    }

    /// @notice 该承诺的揭示状态
    /// @param ballotCommitment 选票承诺
    /// @return 揭示状态枚举
    function revealStatusOf(bytes32 ballotCommitment) external view returns (RevealStatus) {
        return _revealStatus[ballotCommitment];
    }
}
