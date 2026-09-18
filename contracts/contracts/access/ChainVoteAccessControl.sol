// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../libs/Roles.sol";
import "../libs/Errors.sol";

/// @title ChainVoteAccessControl —— 权限基类
/// @notice 全项目唯一权限入口。所有需要角色的合约必须继承本类，不得自行实现权限逻辑。
///
/// @dev 设计约束：
///   1. **无暂停能力**（冻结 Q4）。本类刻意不引入 `Pausable`，也不定义任何暂停类角色。
///      这不是遗漏，是设计要求——见 `hasPauseCapability()` 与 §5.2 硬约束。
///   2. **部署者不是业务管理员**。部署时仅授予 `DEFAULT_ADMIN_ROLE`，
///      业务角色（`CREATOR_ROLE` / `REGISTRAR_ROLE`）需显式单独授予。
///      P8 部署脚本必须在部署后把 `DEFAULT_ADMIN_ROLE` 移交 Timelock 并放弃部署者权限。
///   3. 权限变更全部通过 OpenZeppelin 的 `RoleGranted` / `RoleRevoked` 事件留痕，
///      索引器与告警系统据此监控异常授权（对应 R4 权限泄漏）。
/// @author ChainVote
abstract contract ChainVoteAccessControl is AccessControl {
    /// @notice 部署时指定初始管理员
    /// @param initialAdmin 初始管理员。生产环境应传入 TimelockController 地址；
    ///        若传部署者 EOA，必须在 P8 完成移交，否则不满足上线清单。
    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    /// @notice 全角色清单，供链下与审计核对
    /// @dev 与 `Roles.all()` 保持一致；新增角色时必须同步，否则测试失败
    function roleMatrix() external pure returns (bytes32[2] memory) {
        return Roles.all();
    }

    /// @notice 角色数量
    /// @dev 与 `roleMatrix().length` 构成一致性对：新增角色时若只改 `Roles.all()`
    ///      而忘了改 `Roles.count()`，`roleMatrixCountIsConsistent` 测试会立即失败。
    ///      这是把"容易遗忘的手工同步"变成机械检查。
    function roleCount() external pure returns (uint256) {
        return Roles.count();
    }

    /// @notice 显式声明本系统不存在任何暂停能力
    /// @dev 恒返回 false。该函数的存在本身是一项**审计信号**：
    ///      若未来有人误引入 `Pausable`，此处会被一并修改，从而在评审中暴露。
    ///      对应冻结 Q4：管理员无法提前结束或延时开放投票。
    function hasPauseCapability() external pure returns (bool) {
        return false;
    }

    /// @notice 角色的人类可读名，便于运维日志排查
    /// @param role 角色哈希
    /// @return 角色名；未知角色返回 "UNKNOWN_ROLE"
    function roleName(bytes32 role) external pure returns (string memory) {
        return Roles.nameOf(role);
    }
}
