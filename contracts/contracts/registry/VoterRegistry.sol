// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LeanIMTData, InternalLeanIMT} from "@zk-kit/lean-imt.sol/InternalLeanIMT.sol";

import {ChainVoteAccessControl} from "../access/ChainVoteAccessControl.sol";
import {Roles} from "../libs/Roles.sol";
import {Params} from "../libs/Params.sol";
import "../libs/Errors.sol";

/// @title VoterRegistry —— 选民名册（地址白名单 + 承诺 Merkle 树）
/// @notice 每个提案部署一个实例。承担 N1（身份准入）与 N2（白名单拦截）的链上部分：
///         管理员在**登记期**把「地址 → 承诺」写入本合约，并把承诺插入 LeanIMT；
///         投票期以冻结根（`frozenRoot`）为准，任何不在树中的承诺都无法生成有效 ZK 证明。
///
/// @dev 设计要点与依据：
///
///      **1. 登记有效性只比较 `block.timestamp`，禁用 `phase()`**
///      评审发现 F-01：若用 `phase() == REGISTRATION` 作守卫，则「登记期结束 ~ 投票期开始」
///      的空档期（IDLE）会被判为可登记，成为名册篡改窗口，破坏 INV-7。
///      本合约的唯一守卫是 `block.timestamp >= registrationEnd`。
///
///      **2. 用 `_roster._has()` 取代独立的 `commitmentUsed` 映射**
///      LeanIMT 的 `leaves` 映射本身即「承诺 → 下标+1」，可直接判定承诺是否已存在。
///      若另建 `mapping(uint256 => bool)`，每个选民要多一次 SSTORE（约 20k gas）；
///      复用 `_has` 只需一次 SLOAD（热读约 100 gas）。10 万选民规模下约省 18 亿 gas。
///
///      **3. `_insert` 已内建叶子校验，本合约不重复实现**
///      上游已校验「叶子非零」「叶子 < SNARK 标量域」「叶子不重复」并各自 revert 具名错误。
///      本合约只补充上游无法覆盖的两类**管理员数据错误**：
///      同一地址重复登记（`AlreadyRegistered`）、同一承诺用于两个地址（`CommitmentAlreadyUsed`）。
///      这两类是 CSV 名册导入的高频错误，需要指名具体是哪个地址/哪个承诺。
///
///      **4. 必须发带下标的插入事件**
///      链上只保存 `sideNodes` 与 `size`。前端要生成 ZK 证明，必须在链下**按相同顺序**重建
///      同一棵树，因此 `VoterRegistered` 必须携带 `leafIndex`，且事件顺序即为插入顺序。
///
///      **5. 冻结根为一次性动作，无权限门槛**
///      任何人可在登记期结束后调用 `freezeVotersRoot()`。设计为无门槛是为了避免
///      「管理员拒不冻结导致提案卡死」——与 `finalize()` 的设计原则一致。
///
/// @author ChainVote
contract VoterRegistry is ChainVoteAccessControl {
    using InternalLeanIMT for LeanIMTData;

    // ============================================================
    // 状态
    // ============================================================

    /// @notice 登记期结束时刻（创建后不可变，支撑 N3 时间锁）
    uint64 public immutable REGISTRATION_END;

    /// @notice 承诺 Merkle 树（LeanIMT）
    LeanIMTData private _roster;

    /// @notice 地址 → 承诺。0 表示未登记
    mapping(address => uint256) private _commitmentOf;

    /// @notice 固化后的名册根。仅当 `frozen == true` 时有意义
    uint256 public frozenRoot;

    /// @notice 冻结时的名册人数
    uint32 public eligibleCount;

    /// @notice 是否已固化。独立布尔量用于区分「未冻结」与「已冻结但根为 0」两种情况
    bool public frozen;

    // ============================================================
    // 事件
    // ============================================================

    /// @notice 单个选民完成登记
    /// @dev 【关键】`leafIndex` 必须存在且事件顺序即插入顺序，
    ///      链下据此按序重放，才能得到与链上逐位一致的树
    /// @param voter 选民地址
    /// @param commitment 该地址的身份承诺
    /// @param leafIndex 在名册树中的叶子下标（从 0 起）
    event VoterRegistered(address indexed voter, uint256 commitment, uint256 indexed leafIndex);

    /// @notice 名册根已固化
    /// @param root 固化后的名册根
    /// @param eligibleCount 名册人数
    /// @param frozenAt 固化时的区块时间戳
    event VotersRootFrozen(uint256 indexed root, uint32 eligibleCount, uint64 frozenAt);

    // ============================================================
    // 构造
    // ============================================================

    /// @notice 部署名册合约
    /// @param initialAdmin 初始管理员（生产环境为 Timelock；见 ChainVoteAccessControl）
    /// @param registrationEnd_ 登记期结束时刻
    constructor(address initialAdmin, uint64 registrationEnd_) ChainVoteAccessControl(initialAdmin) {
        if (registrationEnd_ == 0) revert InvalidTimeWindow();
        REGISTRATION_END = registrationEnd_;
    }

    // ============================================================
    // 登记（仅登记期内，仅 REGISTRAR_ROLE）
    // ============================================================

    /// @notice 批量登记选民：写入地址白名单并把承诺插入名册树
    /// @dev 【硬约束】有效期判断使用 `block.timestamp < REGISTRATION_END`，
    ///      **禁止使用 `phase()`**（F-01 回归点，见合约头部说明 1）
    ///
    /// @dev 实现分三阶段，而非「校验一条插一条」：
    ///      **阶段一 · 校验**：逐步指名报错，并写入地址白名单。
    ///      **阶段二 · 批量插入**：调用 `_insertMany` 一次性更新树。
    ///      上游的 `_insertMany` 会缓存 `size` 与 `depth` 并逐层构建，
    ///      而逐条 `_insert` 每次都要重新读写这两个存储槽，实测批量路径显著更省 gas。
    ///      **阶段三 · 发事件**：按插入顺序发出带下标的登记事件。
    ///
    /// @dev 阶段一内含 O(n²) 的**批内重复承诺**检查。理由：`_insertMany` 虽会拒绝重复叶子，
    ///      但抛出的是上游的 `LeafAlreadyExists()`，**不指名是哪一个承诺**。
    ///      批内重复正是 CSV 名册导入最常见的错误，必须能指名定位。
    ///      由于 `Params.MAX_REGISTER_BATCH` 上限为 50，最坏 1225 次比较，
    ///      开销远低于批量插入节省的 gas，故此处的简单实现是划算的。
    ///
    /// @param voters 选民地址数组
    /// @param commitments 与 `voters` 一一对应的身份承诺数组
    function registerVoters(
        address[] calldata voters,
        uint256[] calldata commitments
    ) external onlyRole(Roles.REGISTRAR_ROLE) {
        if (block.timestamp >= REGISTRATION_END) revert RegistrationClosed();

        uint256 n = voters.length;
        if (n != commitments.length) revert ArrayLengthMismatch();
        if (n == 0 || n > Params.MAX_REGISTER_BATCH) revert BatchTooLarge();

        uint256 startIndex = _roster.size;

        // ---- 阶段一：校验 + 写白名单 ----
        for (uint256 i = 0; i < n; ++i) {
            address voter = voters[i];
            uint256 c = commitments[i];

            if (c == 0) revert ZeroCommitment();
            if (_commitmentOf[voter] != 0) revert AlreadyRegistered(voter);
            if (_roster._has(c)) revert CommitmentAlreadyUsed(c);

            // 批内重复检查：与已处理过的本批承诺比对，指名报错
            for (uint256 j = 0; j < i; ++j) {
                if (commitments[j] == c) revert CommitmentAlreadyUsed(c);
            }

            _commitmentOf[voter] = c;
        }

        // ---- 阶段二：一次性批量插入（原子性由整笔交易保证）----
        _roster._insertMany(commitments);

        // ---- 阶段三：事件（顺序即插入顺序，供链下按序重建树）----
        for (uint256 i = 0; i < n; ++i) {
            emit VoterRegistered(voters[i], commitments[i], startIndex + i);
        }
    }

    // ============================================================
    // 固化名册根（无权限门槛，一次性）
    // ============================================================

    /// @notice 登记期结束后固化名册根。**任何人可调用，幂等**
    /// @dev 无权限门槛是刻意设计：避免管理者拒不冻结而导致提案卡死。
    ///      幂等性由 `frozen` 标志保证——重复调用 revert 而非静默成功，
    ///      以便前端能明确区分「刚成功」与「早就冻结过」。
    /// @return root 固化后的名册根
    function freezeVotersRoot() external returns (uint256 root) {
        if (block.timestamp < REGISTRATION_END) revert RegistrationNotEnded();
        if (frozen) revert RootAlreadyFrozen();

        // 空名册（无人登记）不构成有效投票，拒绝冻结
        if (_roster.size == 0) revert EmptyRoster();

        root = _roster._root();
        frozenRoot = root;
        eligibleCount = uint32(_roster.size);
        frozen = true;

        emit VotersRootFrozen(root, eligibleCount, uint64(block.timestamp));
    }

    // ============================================================
    // 查询
    // ============================================================

    /// @notice 地址是否已完成登记
    /// @param voter 待查询地址
    /// @return 已登记返回 true
    function isRegistered(address voter) external view returns (bool) {
        return _commitmentOf[voter] != 0;
    }

    /// @notice 地址对应的身份承诺
    /// @param voter 待查询地址
    /// @return 承诺值；未登记返回 0
    function commitmentOf(address voter) external view returns (uint256) {
        return _commitmentOf[voter];
    }

    /// @notice 当前名册人数
    function rosterSize() external view returns (uint256) {
        return _roster.size;
    }

    /// @notice 当前名册树深度
    function rosterDepth() external view returns (uint256) {
        return _roster.depth;
    }

    /// @notice 当前名册根（登记期内会随插入变化）
    /// @dev 投票期必须改用 `requireFrozenRoot()`，不得使用本函数——
    ///      否则先投票者的 proof 会因根变化而失效（F-06）
    function currentRoot() external view returns (uint256) {
        return _roster._root();
    }

    /// @notice 取冻结根，未冻结则 revert
    /// @dev 供 Proposal 在 `castVote` 中调用，把「必须已冻结」的约束收敛到一处，
    ///      避免在多个合约里各写一遍判空逻辑（F-06）
    /// @return 已固化的名册根
    function requireFrozenRoot() external view returns (uint256) {
        if (!frozen) revert RootNotFrozen();
        return frozenRoot;
    }

    /// @notice 承诺是否在名册树中（不泄露对应地址）
    /// @param commitment 待查询承诺
    /// @return 在树中返回 true
    function isEnrolled(uint256 commitment) external view returns (bool) {
        return _roster._has(commitment);
    }
}
