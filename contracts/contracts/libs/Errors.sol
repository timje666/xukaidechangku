// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Errors —— 全局自定义错误
/// @notice 统一使用 custom error 替代 require 字符串，降低部署体积与 revert 成本（G7）
/// @dev 全部为文件级声明，使用方 `import "./libs/Errors.sol";` 后可直接以裸名引用

// ---------- 阶段与时间窗（N3 / 硬约束 1-2） ----------
/// @notice 当前阶段不满足操作要求
error NotInPhase(uint8 expected, uint8 actual);
/// @notice 登记期已结束（registrationEnd 之后，含 IDLE 空档期）
error RegistrationClosed();
/// @notice 登记期尚未开始
error RegistrationNotOpen();
/// @notice 名册根已固化，不可再次固化
error RootAlreadyFrozen();
/// @notice 名册根尚未固化（投票期必须基于冻结根）
error RootNotFrozen();
/// @notice 提交的 Merkle 根与冻结根不一致
error RootMismatch();

// ---------- 投票 ----------
/// @notice 凭证与提案不匹配（scope 校验失败）
error InvalidScope();
/// @notice 该 nullifier 已使用过
error AlreadyVoted();
/// @notice ZK 证明验证失败
error InvalidProof();

// ---------- 揭示 ----------
/// @notice 该承诺未曾于投票期上链 —— ★F-02 关键防护，禁止删除
error CommitmentNotCast();
/// @notice 明文与承诺哈希不匹配
error CommitmentMismatch();
/// @notice 该承诺已揭示，或已被判废
error AlreadyRevealed();
/// @notice 选中数量超过 maxChoices
error ChoiceLimitExceeded();
/// @notice 位图含越界位
error MaskOutOfRange();

// ---------- 封存与查询 ----------
/// @notice 结果尚未封存，不可查询
error ResultLocked();
/// @notice 已封存，不可重复封存
error AlreadyFinalized();
/// @notice 揭示窗口尚未结束
error RevealWindowOpen();

// ---------- 名册登记（P2） ----------
/// @notice 登记期已结束
error RegistrationNotEnded();
/// @notice 该地址已在名册中
error AlreadyRegistered(address voter);
/// @notice 该承诺已被其他地址使用
error CommitmentAlreadyUsed(uint256 commitment);
/// @notice 承诺不得为零
error ZeroCommitment();
/// @notice 名册为空，不可固化根
error EmptyRoster();

// ---------- 配置校验 ----------
error InvalidOptionCount();
error InvalidMaxChoices();
error InvalidTimeWindow();
error BatchTooLarge();
error ArrayLengthMismatch();
error ProposalNotRegistered();
error ZeroAddress();

// ---------- 中继（MinimalForwarder, F-10） ----------
/// @notice 请求已过期
error DeadlineExpired();
/// @notice EIP-712 签名无效
error InvalidSignature();
/// @notice 该 nonce 已使用
error NonceUsed();
/// @notice 中继调用失败
error ForwardFailed();
