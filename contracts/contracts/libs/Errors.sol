// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Errors —— 全局自定义错误
/// @notice 统一使用 custom error 替代 require 字符串，降低部署体积与 revert 成本（G7）
/// @dev 全部为文件级声明，使用方 `import "./libs/Errors.sol";` 后可直接以裸名引用
///
/// @dev 【维护约束】本文件声明的每个错误都必须至少被一处代码引用。
///      死错误与死代码同样有害：审计者会据此认为存在某条失败路径，而实际没有。
///      该约束由 `test/p1.hard-constraints.test.ts` 的 HC-19 机械守护。

// ---------- 阶段与时间窗（N3 / 硬约束 1-2） ----------
/// @notice 登记期已结束（registrationEnd 之后，含 IDLE 空档期）
error RegistrationClosed();
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
/// @notice 投票期尚未开始
error VotingNotOpen();
/// @notice 投票期已结束
error VotingClosed();
/// @notice 该承诺已投过票
error CommitmentAlreadyCast();

// ---------- 中继（纯中继 / F-10） ----------
/// @notice 投票必须经中继账户提交，已登记地址不得直接提交
/// @dev ★全匿名的强制点，禁止删除。
///
///      若已登记地址直接提交投票交易，原生 `msg.sender` 即该选民地址，
///      `地址 ↔ 选票` 在链上形成公开关联，D2「隐身份」当场失效。
///      而**合约层是唯一能强制拦住它的位置**——依赖前端自觉等于没有保证。
///
///      【为什么不是「强制 msg.sender == 某个中继地址」】
///      初版曾用「强制经 ERC-2771 中继转发」，但**实测证伪**：
///      ERC-2771 的机制是把签名者地址追加进 calldata（`abi.encodePacked(data, from)`），
///      且 `request.from` 本身就在 `execute()` 的 calldata 里。
///      实测一笔中继投票交易：`from` = 中继账户，而**选民登记地址明文出现于 calldata**
///      ——「强制走中继」反而保证了地址上链，与目标完全相反。
///      （证据见 `test/p5.metatx.test.ts` 的身份泄露判定用例，
///        及 `contracts/harness/ERC2771LeakReference.sol`。）
///
///      【为什么「禁止已登记地址直投」是有效的】
///      它阻断了唯一必然泄露身份的路径，同时**不阻碍匿名路径**：
///        · 用第三方中继账户提交           → 通过，链上与身份无关
///        · 用一次性地址自任中继提交         → 通过，一次性地址无法关联身份
///        · 用名册中已登记的地址提交         → **拒绝**（本条）
///      残留风险：客户端若使用某种「把身份带入 calldata」的包装机制，
///      合约看不到 `tx.data` 的全貌，无法拦截。该风险记录于 P5 交付记录 §残留风险。
error MustUseRelayer();

// ---------- 揭示 ----------
/// @notice 揭示期尚未开始
error RevealNotOpen();
/// @notice 揭示期已结束
error RevealClosed();
/// @notice 该承诺未曾于投票期上链 —— ★F-02 关键防护，禁止删除
error CommitmentNotCast();
/// @notice 明文与承诺哈希不匹配
error CommitmentMismatch();
/// @notice 该承诺已揭示，或已被判废
error AlreadyRevealed();

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

// ---------- 名册树一致性（P2；Slither `unused-return` 的正解） ----------
/// @notice 上游 `_insertMany` 的返回值与树内持久化根不一致
/// @dev 这是一条**跨模块契约断言**，不是防御性空检查：
///      链上根由 `_roster.sideNodes[depth]` 承载，而 `_insertMany` 的返回值是
///      同一次计算得到的另一份拷贝。二者同源，正常情况下永不触发。
///      若上游改为「只返回、不再写入 sideNodes[depth]」，登记交易仍会成功，
///      但链上根会静默停留在旧值 —— 这种漂移无法从外部察觉。
///      把它写成 revert 即 fail-closed：宁可登记失败，也不写入陈旧根。
error RosterRootMismatch(uint256 returnedRoot);

// ---------- 配置校验 ----------
error InvalidOptionCount();
error InvalidTimeWindow();
error BatchTooLarge();
error ArrayLengthMismatch();
error ZeroAddress();
