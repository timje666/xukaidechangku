// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import "../libs/Errors.sol";

/// @title Timelock —— 角色治理时间锁（P8）
/// @notice 只承担**角色管理**：作为 `ProposalFactory` 的 `DEFAULT_ADMIN_ROLE` 持有者，
///         使 `CREATOR_ROLE` 的授予与撤销必须经过「排程 → 等待 → 执行」三步，
///         而不是一笔交易就完成。
///
/// @dev 设计要点与依据：
///
///      **1. 不承载任何投票控制权（是设计要求，不是巧合）**
///      本合约**不持有** `CREATOR_ROLE` / `REGISTRAR_ROLE`，也**不被任何投票路径调用**。
///      提案的四阶段流转 100% 由不可变时间参数与 `block.timestamp` 决定（冻结 Q4），
///      时间锁只影响「谁拥有管理员权限」，永不影响「票期在何时开始与结束」。
///      这正是 v2 方案 §4.1 中把本合约画在 `J --> F`（而非 `J --> G`）的原因：
///      它指向工厂的权限，不指向提案的状态机。
///
///      **2. 不继承 `ChainVoteAccessControl`（刻意的例外，须在此说明理由）**
///      项目约定「所有需要角色的合约继承该基类，不得自行实现权限逻辑」。
///      本合约是唯一的例外，理由是**角色集不同源**：
///        · 本合约的角色是**治理角色**（`PROPOSER_ROLE` / `EXECUTOR_ROLE` /
///          `CANCELLER_ROLE` / `DEFAULT_ADMIN_ROLE`），由上游 `TimelockController`
///          在构造时定义，非本仓可枚举；
///        · 而 `ChainVoteAccessControl.roleMatrix()` 只枚举**业务角色**
///          （`Roles.all()` = `CREATOR_ROLE` / `REGISTRAR_ROLE`）。
///      若强行继承，`roleMatrix()` 会对外谎报「本合约只有 2 个角色」，
///      且 `roleCount()` 与实际角色数不一致 —— 这比不继承危险得多。
///      本合约不持有任何业务角色，故不进入业务权限矩阵。
///
///      **3. 最小延时有硬下限（构造期 fail-closed）**
///      `minDelay` 不得低于 `MIN_TIMELOCK_DELAY`。理由见 `Errors.sol` 中
///      `TimelockDelayTooShort` 的说明：低于下限的「时间锁」提供不了异议窗口。
///      该下限由**合约**而非部署脚本强制，因此链上可验证、不可被部署参数绕过。
///
///      **4. 默认自管理（部署脚本传 `admin = address(0)`）**
///      若把某个 EOA 设为构造期的 `admin`，该 EOA 可在**无延时**下授予任意角色，
///      时间锁形同虚设。部署脚本因此默认传零地址：`DEFAULT_ADMIN_ROLE` 由本合约
///      自身持有 —— 连「修改 minDelay」都必须走时间锁流程。
///      即上游文档所述的 self administration。
///
///      **5. 执行者默认开放（`executors = [address(0)]`）**
///      操作一旦排程，其内容与目标在链上公开且不可篡改，等待期满后由谁提交
///      并不影响安全性。开放执行者消除了「执行方离线导致治理卡死」的单点，
///      因此部署脚本默认采用该形式（见 `deploy-core.ts`）。
///
/// @author ChainVote
contract Timelock is TimelockController {
    /// @notice 最小延时下限：2 天。低于此值的构造直接 revert
    /// @dev 取值依据：投票相关的角色变更（`CREATOR_ROLE` / `REGISTRAR_ROLE`）
    ///      牵涉「谁能创建提案」「谁能登记名册」，任一误授权都需要足够的
    ///      公示时间供观察者发现并撤销。2 天与揭示窗口（48h，冻结 Q3）同量级，
    ///      是「足够长到可被察觉、又短到不至于卡住运维」的平衡点。
    uint256 public constant MIN_TIMELOCK_DELAY = 2 days;

    /// @notice 部署时间锁
    /// @param minDelay 操作最小延时（秒），不得低于 `MIN_TIMELOCK_DELAY`
    /// @param proposers 可排程与撤销操作的一方（生产环境为多签钱包）
    /// @param executors 可执行到期操作的一方；数组含零地址表示任何人可执行
    /// @param admin 可选的无延时管理员；传零地址表示由本合约自管理（推荐）
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        if (minDelay < MIN_TIMELOCK_DELAY) revert TimelockDelayTooShort(minDelay, MIN_TIMELOCK_DELAY);
    }
}
