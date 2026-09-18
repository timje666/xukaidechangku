// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Roles —— 角色常量与权限边界
/// @notice 唯一真相源。每个角色与实现方案 v2.1 §5.2「权限矩阵」一一对应。
///
/// @dev 【硬约束 10】本文件**不得**出现任何形式的暂停 / 紧急停投 / 守护者角色，
///      包括但不限于 `PAUSER_ROLE`、`PAUSE_ROLE`、`GUARDIAN_ROLE`、`EMERGENCY_ROLE`。
///
///      依据：冻结 Q4 —— 不保留任何管理员干预票期的接口。
///      票期开关 100% 由不可变时间参数与 `block.timestamp` 决定（N3）。
///
///      该约束由 `test/p1.hard-constraints.test.ts` 机械性守护：
///      一旦有人重新引入暂停类角色，测试立即失败。
/// @author ChainVote
library Roles {
    /// @notice 创建提案：`ProposalFactory.createProposal`
    /// @dev 授予方应为 Election Admin；本角色不赋予任何修改已创建提案的能力
    bytes32 internal constant CREATOR_ROLE = keccak256("ChainVote.CREATOR_ROLE");

    /// @notice 登记选民名册：`VoterRegistry.registerVoters`
    /// @dev 【关键】该角色**只在登记期内有效**。合约侧必须用
    ///      `block.timestamp < registrationEnd` 判断，禁止使用 `phase()`，
    ///      否则 IDLE 空档期将成为名册篡改窗口（F-01，破坏 INV-7）。
    ///      这是本项目权限模型中风险最高的一项——它决定了谁能投票。
    bytes32 internal constant REGISTRAR_ROLE = keccak256("ChainVote.REGISTRAR_ROLE");

    /// @notice 全角色清单（供链下与审计核对）
    /// @dev 新增角色时必须同步更新本函数，否则 roleMatrix 测试会失败
    function all() internal pure returns (bytes32[2] memory) {
        return [CREATOR_ROLE, REGISTRAR_ROLE];
    }

    /// @notice 角色数量（新增角色时需同步 +1）
    function count() internal pure returns (uint256) {
        return 2;
    }

    /// @notice 人类可读的角色名，便于日志与运维排查
    /// @param role 角色哈希
    /// @return 角色名；未知角色返回 "UNKNOWN_ROLE"
    function nameOf(bytes32 role) internal pure returns (string memory) {
        if (role == CREATOR_ROLE) return "CREATOR_ROLE";
        if (role == REGISTRAR_ROLE) return "REGISTRAR_ROLE";
        if (role == 0x00) return "DEFAULT_ADMIN_ROLE";
        return "UNKNOWN_ROLE";
    }

    /// @notice 审计者、公众观察者**不需要任何链上角色**
    /// @dev 只读访问（`view` 函数与事件订阅）本身不受权限控制。
    ///      不要为只读用途创建角色——那会制造出可被误授予的、无实际用途的权限面。
    bool internal constant AUDITOR_NEEDS_ONCHAIN_ROLE = false;
}
