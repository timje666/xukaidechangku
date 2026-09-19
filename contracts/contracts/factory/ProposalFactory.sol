// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ChainVoteAccessControl} from "../access/ChainVoteAccessControl.sol";
import {Proposal, ProposalInit} from "../proposal/Proposal.sol";
import {Roles} from "../libs/Roles.sol";
import "../libs/Errors.sol";

/// @title ProposalFactory —— 提案创建、索引与全局角色（P7）
/// @notice 全系统**唯一**的提案创建入口。职责有三：
///         ① 创建：为每个提案分配全局唯一编号并部署一个 `Proposal` 实例（N5：一提案一实例）
///         ② 索引：维护「编号 → 地址」与「下标 → 地址」两套索引，供索引器与前端查询
///         ③ 全局角色：以 `CREATOR_ROLE` 约束「谁能创建提案」——这是**全局**权限，
///            与提案内部由时间窗自动推进的状态机完全解耦
///
/// @dev 设计要点：
///
///      **1. 编号由工厂分配，不接受调用方传入**
///      `createProposal` 强制 `init.proposalId == 0` 并自行递增 `proposalCount`。
///      编号是结果哈希与索引器关联提案的键，允许外部指定会让两个提案撞号，
///      使「提案 ↔ 结果」的映射出现歧义（见 Errors.sol 中 `ProposalIdMustBeZero` 的说明）。
///
///      **2. 创建计数与索引数组恒等（INV-11）**
///      `proposalCount`（计数）与 `_proposals.length`（索引）在每次成功创建时同步 +1，
///      二者恒等是一条链上不变量，由 P6 的 INV-11 随机战役守护。
///      第 i 个下标（0 起）对应提案编号 i+1，故 `proposalOf(i+1) == proposalAt(i)`。
///
///      **3. 提案的初始管理员由工厂统一指定，不由调用者决定**
///      `PROPOSAL_ADMIN` 在工厂构造时冻结（生产环境为 Timelock）。
///      若允许每次创建时指定管理员，则创建权限会隐含「指定任意管理员」的越权能力。
///
///      **4. 工厂不能干预已创建的提案**
///      本合约不含任何「暂停 / 修改 / 删除提案」的接口。提案一旦部署，其阶段 100% 由
///      `block.timestamp` 决定（冻结 Q4）。工厂只负责「生」，不负责「养」。
///
///      **5. 内联 `Proposal` 创建码的体积说明**
///      `new Proposal(...)` 会把 `Proposal` 的创建字节码内联进本合约的运行时代码。
///      生产配置（optimizer 开启）下 `Proposal` 创建码约 10 KB，工厂整体仍远小于
///      EIP-170 的 24 KiB 上限，由 `scripts/check-contract-size.mjs` 在 CI 中以生产构建为基准校验。
///      覆盖率构建会关闭 optimizer 并注入插桩，字节码膨胀属工具产物、并非可部署形态，
///      故覆盖率模式下测试网络放宽了体积限制（见 hardhat.config.ts 的说明）。
///
/// @author ChainVote
contract ProposalFactory is ChainVoteAccessControl {
    // ============================================================
    // 不可变配置
    // ============================================================

    /// @notice 每个新建提案的初始管理员（生产环境为 TimelockController）
    /// @dev 由工厂构造时冻结，避免创建权限隐含「指定任意管理员」的能力
    address public immutable PROPOSAL_ADMIN;

    // ============================================================
    // 状态
    // ============================================================

    /// @notice 已创建的提案总数，同时是最后分配的提案编号（1 起；0 表示尚未创建）
    uint256 public proposalCount;

    /// @notice 提案地址索引。第 i 项（0 起）对应提案编号 i+1
    address[] private _proposals;

    /// @notice 提案编号（1 起）→ 提案地址
    mapping(uint256 => address) private _proposalById;

    /// @notice 该地址是否为**本工厂创建**的提案
    mapping(address => bool) private _isProposal;

    // ============================================================
    // 事件
    // ============================================================

    /// @notice 新提案已创建
    /// @dev 保留 `creator` 与 `metadataCid` 供索引器与审计使用。
    ///      创建阶段身份本就公开（与登记期同理），故此处记录地址不违反匿名设计——
    ///      「隐身份」只约束投票 / 揭示 / 封存路径（见 P6 的 INV-10）。
    /// @param proposalId 分配的提案编号
    /// @param proposal 部署的提案合约地址
    /// @param creator 调用创建的一方（持有 CREATOR_ROLE）
    /// @param metadataCid IPFS 元数据 CID
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposal,
        address indexed creator,
        bytes32 metadataCid
    );

    // ============================================================
    // 构造
    // ============================================================

    /// @notice 部署工厂
    /// @param initialAdmin 初始管理员。同时作为**所有新提案**的初始管理员
    constructor(address initialAdmin) ChainVoteAccessControl(initialAdmin) {
        PROPOSAL_ADMIN = initialAdmin;
    }

    // ============================================================
    // 创建
    // ============================================================

    /// @notice 创建一个新提案
    /// @dev 门禁为全局 `CREATOR_ROLE`（见 Roles.sol）。已创建提案的行为不受本函数影响。
    /// @param init 提案初始化参数。`proposalId` 必须为 0，由本函数分配；其余字段原样透传
    /// @return proposalId 分配的提案编号（1 起，单调递增）
    /// @return proposal 部署的提案合约地址
    function createProposal(
        ProposalInit calldata init
    ) external onlyRole(Roles.CREATOR_ROLE) returns (uint256 proposalId, address proposal) {
        if (init.proposalId != 0) revert ProposalIdMustBeZero();

        proposalId = ++proposalCount;

        ProposalInit memory assigned = init;
        assigned.proposalId = proposalId;

        Proposal deployed = new Proposal(PROPOSAL_ADMIN, assigned);
        proposal = address(deployed);

        _proposals.push(proposal);
        _proposalById[proposalId] = proposal;
        _isProposal[proposal] = true;

        emit ProposalCreated(proposalId, proposal, msg.sender, init.metadataCid);
    }

    // ============================================================
    // 查询
    // ============================================================

    /// @notice 索引数组长度。恒等于 `proposalCount`（INV-11）
    /// @return 已创建提案数
    function proposalsLength() external view returns (uint256) {
        return _proposals.length;
    }

    /// @notice 按下标取提案地址
    /// @param index 下标（0 起）
    /// @return 提案地址；下标越界时 revert
    function proposalAt(uint256 index) external view returns (address) {
        if (index >= _proposals.length) revert UnknownProposal(index);
        return _proposals[index];
    }

    /// @notice 按编号取提案地址
    /// @param proposalId 提案编号（1 起）
    /// @return 提案地址；编号不存在时 revert
    function proposalOf(uint256 proposalId) external view returns (address) {
        address found = _proposalById[proposalId];
        if (found == address(0)) revert UnknownProposal(proposalId);
        return found;
    }

    /// @notice 该地址是否为已创建的提案
    /// @param candidate 待查地址
    /// @return 是本工厂创建的提案返回 true
    function isProposal(address candidate) external view returns (bool) {
        return _isProposal[candidate];
    }
}
