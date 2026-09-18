// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IVoterRegistry —— 名册合约的最小读取接口
/// @notice Proposal 只需要「取冻结根」与两个只读查询，故只声明这三项，
///         避免 Proposal 依赖 VoterRegistry 的全部内部实现。
/// @author ChainVote
interface IVoterRegistry {
    /// @notice 取冻结的名册根；未冻结则 revert `RootNotFrozen()`
    /// @return 已固化的名册根
    function requireFrozenRoot() external view returns (uint256);

    /// @notice 名册根是否已固化
    /// @return 已固化返回 true
    function frozen() external view returns (bool);

    /// @notice 固化后的名册根（未固化时为 0）
    /// @return 名册根
    function frozenRoot() external view returns (uint256);
}
