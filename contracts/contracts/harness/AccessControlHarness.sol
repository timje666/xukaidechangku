// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../access/ChainVoteAccessControl.sol";
import "../libs/Roles.sol";

/// @title AccessControlHarness —— 测试夹具
/// @notice 提供两个示例业务入口，用于验证角色门禁的真实行为。
///         不包含任何业务逻辑，仅为让"未授权调用被拒绝"可被观测。
contract AccessControlHarness is ChainVoteAccessControl {
    event ProposalCreatedBy(address indexed caller, uint256 proposalId);
    event VoterRegisteredBy(address indexed caller, address indexed voter);

    uint256 public proposalCount;
    mapping(address => bool) public isRegistered;

    constructor(address initialAdmin) ChainVoteAccessControl(initialAdmin) {}

    /// @notice 受 `CREATOR_ROLE` 保护
    function createProposal() external onlyRole(Roles.CREATOR_ROLE) returns (uint256 proposalId) {
        proposalId = ++proposalCount;
        emit ProposalCreatedBy(msg.sender, proposalId);
    }

    /// @notice 受 `REGISTRAR_ROLE` 保护
    function registerVoter(address voter) external onlyRole(Roles.REGISTRAR_ROLE) {
        isRegistered[voter] = true;
        emit VoterRegisteredBy(msg.sender, voter);
    }
}
