# P3 · Proposal 状态机 · 交付记录

| 项 | 内容 |
| --- | --- |
| 阶段 | P3（见 `区块链去中心化投票系统-实现方案-v2.md` §10） |
| 状态 | **已完成**（不含 ZK，ZK 校验留在 P4） |
| 执行日期 | 2026-09-18 |
| 前置 | P0 环境、P1 角色与门禁、L5 依赖验证、P2 VoterRegistry |

---

## 1. DoD 验证结果（全部实测）

| # | 完成标准 | 实测 | 判定 |
| --- | --- | --- | --- |
| 1 | 六阶段状态机按时间单调推进（INV-5） | `REGISTRATION → IDLE → VOTING → REVEAL → CLOSED → FINALIZED` 逐点断言 | ✅ |
| 2 | 不存在任何可改变阶段的写接口 | 接口扫描：无 `setPhase`/`pause`/`extend`/`earlyClose`/`forceFinalize` | ✅ |
| 3 | `getCounts()` 封存前 revert（硬约束 3） | `ResultLocked()`；`getResultHash()` 同 | ✅ |
| 4 | 时窗守卫不使用 `phase()`（F-01 同类风险） | IDLE 期间投票被判 `VotingNotOpen` | ✅ |
| 5 | **F-02 关键防护**：未上链承诺不可揭示 | 自造合法 (mask, salt) 被 `CommitmentNotCast()` 拒绝 | ✅ |
| 6 | 单条坏票不阻断同批其余票 | 超限票被标记 `REJECTED` 并计入 `rejectedCount`，同批好票正常计入 | ✅ |
| 7 | INV-1 / INV-2 / INV-6 成立 | 票数守恒、揭示不超额、封存后结果恒定 | ✅ |
| 8 | 格式 / 静态分析 / 编译 / 链接 / 体积 | Prettier 合规；solhint **0 error / 0 warning**；verify 全链路通过 | ✅ |
| 9 | 单元测试 | **125 passing**（P2 91 → P3 125，新增 34 项） | ✅ |
| 10 | 覆盖率 | 行 **100.00%**(158/158) · 语句 98.63% · 分支 97.76% | ✅ |

---

## 2. 交付物

```text
contracts/
├── contracts/proposal/
│   └── Proposal.sol                 ★ 新增：四阶段状态机 + 承诺/揭示/封存
├── contracts/harness/
│   └── ProposalHarness.sol          ★ 新增：暴露 internal 投票路径（仅测试用）
├── contracts/libs/Params.sol        新增 MAX_REVEAL_BATCH；移除冗余的 BALLOT_COMMITMENT_DOMAIN
├── contracts/libs/Errors.sol        新增 6 个投票/揭示相关错误
└── test/p3.proposal.test.ts         ★ 新增：34 项测试

scripts/
└── report-coverage-gaps.mjs         ★ 重写豁免机制（见 §5）
```

**核心接口**

| 函数 | 权限 | 说明 |
| --- | --- | --- |
| `phase()` | 只读 | 六阶段，完全由 `block.timestamp` 推导 |
| `_recordBallot(nullifier, commitment)` | `internal` | 投票期记录承诺。**external 入口留给 P4 的 `castVote`** |
| `reveal(RevealPayload[])` | **无权限门槛** | 任何人可揭示；单批 ≤ 100 |
| `finalize()` | **无权限门槛** | 揭示窗口结束后任何人可封存，幂等 |
| `getCounts()` / `getResultHash()` | 只读 | **封存前 revert** |

---

## 3. 关键设计决策

### 3.1 ★ P3 刻意不暴露 `castVote`

方案原文写「P3 先不含 ZK」。若照字面实现一个「不校验证明的 external `castVote`」，
那么在这个过渡版本里**任何人都能投票**——一个「可部署但已被掏空」的合约。

**处置**：投票路径 `_recordBallot` 实现为 `internal`，**P3 不提供任何 external 投票入口**。
状态机行为通过 `ProposalHarness`（继承 `Proposal`，加一层 external 转发）测试。
P4 再增加带 ZK 校验的 `castVote` 调用它。

**收益**：任何时候都不存在一个「看似可用、实则无门槛」的投票接口可供误部署。
代价：多一个测试夹具文件，且该夹具在 P4 后仍有用途（直接构造非法位图、超限选择等
**经 ZK 电路无法构造**的边界状态）。

### 3.2 选票承诺带提案域分隔（隐私增强）

`ballotCommitment = Poseidon4([ballotMask, salt, SCOPE])`，其中
`SCOPE = H(SCOPE_DOMAIN, chainId, address(this))` 全局唯一。

**为什么需要第三个输入**：若承诺只是 `Poseidon(mask, salt)`，当同一选民在两个提案中
**复用了同一个 salt**（客户端 bug 或刻意为之），观察者用 A 提案揭示出的 `(mask, salt)`
去比对 B 提案的承诺集合，命中即可判定两票属于同一人——**跨提案可关联**。

引入域分隔后，即使 salt 复用，两个提案中的承诺也不相同。测试
`同一 (mask, salt) 在不同提案中产生不同承诺` 已把这个性质固定下来。

**连带清理**：`Params.BALLOT_COMMITMENT_DOMAIN` 因此成为冗余的第二套域常量，已删除
（两套并存只会造成「到底用哪一个」的歧义）。域分隔统一由 `scopeOf()` 提供。

### 3.3 揭示失败不 revert，而是标记作废

单条揭示若因选择超限/位图越界被拒，**不 revert 整批**：
否则一条坏票会让同批其余所有票都无法揭示（攻击者可用一张必然作废的票阻断他人批量揭示）。

被拒的承诺立即标记 `REJECTED` 并计入 `rejectedCount`：
- **不可重试** —— 否则可被反复提交空耗 gas
- **公开可见** —— `rejectedCount` 进入结果公示口径（冻结 Q9）

### 3.4 构造器校验的边界缺陷（已修）

`Params.validateTimeWindows` 原先直接算 `registrationEnd - now_`。
若 `registrationEnd < now_`，该减法**下溢并抛出算术 panic（0x11）**，而非本项目的具名错误——
前端拿到 panic 无法映射为可读文案。

**修复**：在减法之前先判 `registrationEnd <= now_` 并返回 false。
对应测试 `★ registrationEnd 早于当前时刻应给出具名错误，而非算术 panic`。

---

## 4. 实测数据

### 4.1 方法级 gas

| 操作 | gas | 说明 |
| --- | --- | --- |
| `recordBallot`（P3，无 ZK） | 74,388 – 91,488 | P4 接入证明校验后将增加约 25–35 万 |
| **`reveal`（单条）** | **约 141,541** | 主要成本是 PoseidonT4 的 DELEGATECALL + 计票 SSTORE |
| `finalize` | 91,710 | O(optionCount)，不遍历票据 |
| `Proposal` 部署 | 约 1,624,253 | 一次性 |

### 4.2 单票全链路成本（10 万选民，L2 @ 0.02 gwei / ETH 3,000，量级估算）

| 环节 | 每票 gas | 来源 |
| --- | --- | --- |
| 名册登记 | 88,432 | P2 实测 |
| 投票（含 ZK） | 约 250,000 – 350,000 | **P4 待实测** |
| 揭示 | 141,541 | P3 实测 |
| **合计** | **约 480,000 – 580,000** | |
| **10 万选民总计** | 约 0.96 – 1.16 ETH | 约 **$2,900 – 3,500** |

> **注意**：这不是承诺值，是量级估算。P4/USD 汇率与 gas price 均会波动。

### 4.3 性能优化候选（留待 P6 评估）

| # | 候选 | 预期收益 |
| --- | --- | --- |
| 1 | 把 `_commitmentCast` 与 `_revealStatus` 合并为单一 `mapping(bytes32 => uint8)`（0=未上链） | 每条揭示省一次冷 SLOAD（约 2,100 gas） |
| 2 | 多选计票的 `_counts[i]` 逐项 SSTORE 改为按位累加后一次性写入 | 选 8 项时省约 2 万 gas / 票 |
| 3 | `reveal` 批量提交摊薄基础费 | 已在设计内（单批 ≤ 100） |

**不做前置优化**：以上收益相对总量约 3–5%，在 P6 有实测数据前不值得增加复杂度。

---

## 5. 覆盖率豁免机制的返工

### 5.1 问题

P1 建立的豁免机制是**按行号硬编码**的：

```js
{ file: "contracts/libs/Params.sol", branches: ["6#0", "11#0"], reason: "..." }
```

P3 编辑 `Params.sol`（新增 `MAX_REVEAL_BATCH`、修正下溢）后，幻影分支的行号**漂移到 5#0/7#0/12#0**，
原豁免立即失效并产生**假失败**。

这暴露了机制本身的缺陷：**用不稳定标识（行号）去登记豁免**。

### 5.2 修复

改为按「该行是否可能包含分支」判定，规则可泛化且不随编辑失效：

| 判定条件 | 说明 |
| --- | --- |
| 空行 | 不可能含控制流 |
| 纯注释行（`//` `///` `/*` `*` `*/`） | 不可能含控制流 |
| 纯 `constant` 声明行 | 编译期内联，无分支 |

任何含条件、循环、三元、`&&`/`||` 或函数调用的行**一律照常报出**。
脚本内明确写入：**禁止按行号硬编码豁免**。

修复后输出：

```
已按「行性质」自动豁免的插桩幻影（该行不含任何控制流）：
    contracts/libs/Params.sol  (3 处)
✓ 生产合约（不含测试夹具）行与分支全部覆盖
```

### 5.3 通用教训

**用于定位问题的标识必须是稳定的。** 行号、偏移量这类标识会随无关编辑漂移，
用它登记豁免等于埋下一个必然触发的假失败。

---

## 6. 过程中修复的问题

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | 全部测试在构造器即失败（`InvalidTimeWindow`） | **测试侧缺陷**：fixture 设 `registrationEnd = now + 1h` 恰好等于下限，而部署交易使 `block.timestamp` 前进 1 秒 → 余量不足。改为 2h/4h/8h 并加注释说明 |
| 2 | 8 项测试失败：4 项未传库地址、4 项时间推进顺序错 | 二次部署 `ProposalHarness` 需传 `libraries: { PoseidonT4 }`；揭示类测试需在记录选票**之后**再推进到揭示期 |
| 3 | solhint 15 条告警 | 补齐 14 处 NatSpec；`ProposalInit` 字段重排以消除 `gas-struct-packing` |
| 4 | 链接检查脚本按合约登记，P3 引入 `PoseidonT4` 后条目膨胀 | **重构为按库登记**：链接依赖来自「调用了哪个 public 库」，与调用方无关；按库登记只需在引入新库时更新一次 |
| 5 | 覆盖率豁免因行号漂移产生假失败 | 重写豁免机制（见 §5） |

---

## 7. 遗留与下一步

| # | 遗留项 | 移交 |
| --- | --- | --- |
| 1 | **`castVote(ZKProof)` 外部入口** | **P4**（核心交付） |
| 2 | Semaphore 验证器的实际 gas | P4 |
| 3 | 单票全链路成本的实测（含 ZK） | P4 |
| 4 | §4.3 的三项优化是否值得做 | P6 |

**下一步 P4：Semaphore 集成**

| 交付 | 关键点 |
| --- | --- |
| `castVote(ZKProof)` | 校验顺序：时间窗 → `frozenRoot` → `scope` → `nullifier` 未用（只读） → `verifyProof` → **写入**（F-05 硬约束：写入必须在验证通过之后） |
| `SemaphoreVerifier` 接入 | 用官方验证器，**禁止手写** |
| 必测 | 伪造 proof、错误 root、错误 scope、跨提案重放 **100% revert**；INV-9（写入滞后） |
| 前置 | `ISemaphoreVerifier` 接口已在 L5 验证可引用 ✅ |
