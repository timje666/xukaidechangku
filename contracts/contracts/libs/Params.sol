// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Params —— 全局参数冻结表
/// @notice P0 交付物。本文件是全部业务参数的**唯一真相源**。
///         修改本文件任一常量 = 需求变更，必须同步更新
///         `docs/区块链去中心化投票系统-实现方案-v2.md` 的冻结记录（§0.3 / §11）。
/// @dev 全部常量为编译期内联，无存储开销、无读取 gas。
/// @author ChainVote
library Params {
    // ============================================================
    // 1. 选项与选票  —— 来源：D4（可多选）、Q6（maxChoices ≤ 8）
    // ============================================================

    /// @notice 选项数下限（少于 2 个选项不构成投票）
    uint8 internal constant MIN_OPTION_COUNT = 2;

    /// @notice 选项数上限，受 uint16 位图位宽约束
    uint8 internal constant MAX_OPTION_COUNT = 16;

    /// @notice 每人最少可选数
    uint8 internal constant MIN_MAX_CHOICES = 1;

    /// @notice 每人最多可选数上限 —— 【冻结 Q6】
    /// @dev 因投票期为承诺、无法校验位图，放宽此值会直接抬高揭示期作废率
    uint8 internal constant MAX_MAX_CHOICES = 8;

    // ============================================================
    // 2. 时间窗  —— 来源：N3（链上时间锁）、Q3（揭示窗口 48h）
    // ============================================================

    uint64 internal constant MIN_REGISTRATION_WINDOW = 1 hours;
    uint64 internal constant MIN_VOTING_WINDOW = 1 hours;
    uint64 internal constant MIN_REVEAL_WINDOW = 1 hours;

    /// @notice 揭示窗口默认值 —— 【冻结 Q3】
    uint64 internal constant DEFAULT_REVEAL_WINDOW = 48 hours;

    /// @notice 揭示窗口上限：防止误配成"事实永不封存"
    uint64 internal constant MAX_REVEAL_WINDOW = 30 days;

    /// @notice 时间边界容差 —— 来源：R5（时间操纵防护）
    /// @dev 出块时间存在秒级偏移，边界判定不依赖精确到秒的比较
    uint64 internal constant TIMESTAMP_TOLERANCE = 60;

    // ============================================================
    // 3. 名册登记  —— 来源：N1/N2；上限依据 F-09 实测修正
    // ============================================================

    /// @notice 单笔登记的地址上限
    /// @dev 每地址约 60k–100k gas（whitelist SSTORE + LeanIMT 插入），
    ///      50 地址 ≈ 3–5M gas，留足余量避免超出单笔交易 gas 上限
    uint256 internal constant MAX_REGISTER_BATCH = 50;

    /// @notice 单笔揭示的票数上限
    /// @dev 单条揭示含一次 Poseidon 校验与计票，约 6–10 万 gas，
    ///      100 条约 6–10M gas，安全落在单笔交易 gas 上限内
    uint256 internal constant MAX_REVEAL_BATCH = 100;

    // ============================================================
    // 4. 揭示结果码  —— 来源：Q9（未揭示票作废并公示）
    // ============================================================

    uint8 internal constant REASON_CHOICE_LIMIT = 1;
    uint8 internal constant REASON_MASK_OUT_OF_RANGE = 2;

    // ============================================================
    // 5. Relayer 额度  —— 来源：Q5
    // ============================================================

    /// @notice 每个提案中，单个地址可免费中继的投票次数上限
    uint256 internal constant RELAYER_FREE_QUOTA_PER_PROPOSAL = 20;

    // ============================================================
    // 6. 域分隔符  —— 防止跨提案 / 跨链重放
    // ============================================================

    /// @notice scope 的域分隔标签
    /// @dev 选票承诺的域分隔由 `scopeOf()` 提供（同一提案内 SCOPE 唯一），
    ///      **不再单设** `BALLOT_COMMITMENT_DOMAIN` —— 那是冗余的第二套域常量，
    ///      两套并存只会造成「到底用哪一个」的歧义。
    bytes32 internal constant SCOPE_DOMAIN = keccak256("ChainVote.Scope.v1");
    bytes32 internal constant RESULT_HASH_DOMAIN = keccak256("ChainVote.Result.v1");

    /// @notice 计算本提案的 ZK scope
    /// @dev 绑定 chainId 与提案合约地址，使同一身份在不同提案 / 不同链上
    ///      产生不同 nullifier，且同一 proof 无法跨提案重放（防护 R7）
    /// @param chainId 当前链 ID
    /// @param proposal 提案合约地址
    /// @return 该提案的 scope 值
    function scopeOf(uint256 chainId, address proposal) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(SCOPE_DOMAIN, chainId, proposal)));
    }

    // ============================================================
    // 7. 配置校验  —— 创建提案时强制调用，把非法参数挡在部署之前
    // ============================================================

    /**
     * @notice 校验四段时间窗的合法性与相对关系
     * @param now_ 创建时刻（调用方传 block.timestamp）
     * @param registrationEnd 登记期结束时刻
     * @param votingStart 投票期开始时刻
     * @param votingEnd 投票期结束时刻（揭示期开始）
     * @param revealEnd 揭示期结束时刻（此后可封存）
     * @return ok 全部合法时返回 true
     */
    function validateTimeWindows(
        uint64 now_,
        uint64 registrationEnd,
        uint64 votingStart,
        uint64 votingEnd,
        uint64 revealEnd
    ) internal pure returns (bool ok) {
        // 必须先判「登记期结束时刻晚于当前时刻」，否则下一行的减法会下溢，
        // 抛出的将是算术 panic（0x11）而非本项目的具名错误，前端无法映射为可读文案
        if (registrationEnd <= now_) return false;

        // 四个时间点严格递增
        if (!(registrationEnd < votingStart)) return false;
        if (!(votingStart < votingEnd)) return false;
        if (!(votingEnd < revealEnd)) return false;

        // 各段不得短于下限
        if (registrationEnd - now_ < MIN_REGISTRATION_WINDOW) return false;
        if (votingEnd - votingStart < MIN_VOTING_WINDOW) return false;
        if (revealEnd - votingEnd < MIN_REVEAL_WINDOW) return false;

        // 揭示窗口不得超上限（防止"事实永不封存"）
        if (revealEnd - votingEnd > MAX_REVEAL_WINDOW) return false;

        return true;
    }

    /// @notice 校验选项配置
    /// @param optionCount 选项数
    /// @param maxChoices 每人最多可选数
    /// @return 配置合法时返回 true
    function validateOptions(uint8 optionCount, uint8 maxChoices) internal pure returns (bool) {
        if (optionCount < MIN_OPTION_COUNT || optionCount > MAX_OPTION_COUNT) return false;
        if (maxChoices < MIN_MAX_CHOICES || maxChoices > MAX_MAX_CHOICES) return false;
        if (maxChoices > optionCount) return false;
        return true;
    }
}
