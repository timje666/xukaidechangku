// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Proposal, ProposalInit} from "../proposal/Proposal.sol";
import "../libs/Errors.sol";

/// @title ProposalHarness —— 测试夹具
/// @notice 唯一作用是把 `Proposal._recordBallot`（`internal`）暴露为外部可调用，
///         以便在 P3 阶段（尚未接入 ZK 校验）完整测试状态机。
///
/// @dev 为什么需要它：
///      P3 刻意**不**为 `Proposal` 提供「不带 ZK 证明校验的 external 投票入口」——
///      即便只是过渡版本，也不让一个「任何人可投票」的外部函数出现在可部署合约里。
///      因此状态机的验证路径必须经由夹具。
///
///      【P4 之后】`Proposal` 会增加带 ZK 校验的 `castVote`，
///      本夹具仍保留，用于直接构造边界状态（如非法位图、超限选择）——
///      这些状态经由真实 `castVote` 是无法构造的（ZK 电路不允许）。
///
/// @author ChainVote
contract ProposalHarness is Proposal {
    /// @notice 部署夹具
    /// @param initialAdmin 初始管理员
    /// @param init 提案初始化参数
    constructor(address initialAdmin, ProposalInit memory init) Proposal(initialAdmin, init) {}

    /// @notice 记录单张选票承诺（绕过 ZK 校验，仅测试用）
    /// @param nullifier 选民假名
    /// @param ballotCommitment 选票承诺
    function recordBallot(uint256 nullifier, bytes32 ballotCommitment) external {
        _recordBallot(nullifier, ballotCommitment);
    }

    /// @notice 批量记录选票承诺（绕过 ZK 校验，仅测试用）
    /// @param nullifiers 选民假名数组
    /// @param commitments 选票承诺数组
    function recordBallots(uint256[] calldata nullifiers, bytes32[] calldata commitments) external {
        if (nullifiers.length != commitments.length) revert ArrayLengthMismatch();
        for (uint256 i = 0; i < nullifiers.length; ++i) {
            _recordBallot(nullifiers[i], commitments[i]);
        }
    }

    /// @notice 暴露 `Proposal._hash` 供公式断言（仅测试用）
    /// @dev 真实环境里该函数无法被独立观测，其正确性只能靠「合法证明被接受」间接印证。
    ///      暴露出来后可与其上游定义逐值比对，把这类错误拦在本地。
    /// @param x 待哈希值
    /// @return 落在 SNARK 标量域内的哈希值
    function hashScalar(uint256 x) external pure returns (uint256) {
        return _hash(x);
    }
}
