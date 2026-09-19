# P2 · VoterRegistry（地址白名单 + 承诺 Merkle 名册）· 交付记录

| 项 | 内容 |
| --- | --- |
| 阶段 | P2（见 `区块链去中心化投票系统-实现方案-v2.md` §10） |
| 状态 | **已完成** |
| 执行日期 | 2026-09-18 |
| 前置 | P0 环境、P1 角色体系与门禁、**L5 依赖验证**（决定 Merkle 树实现选型） |

---

## 1. DoD 验证结果（全部实测）

| # | 完成标准 | 实测 | 判定 |
| --- | --- | --- | --- |
| 1 | 非登记地址无法获得有效承诺 | 无 `REGISTRAR_ROLE` 时 `registerVoters` 拒绝 | ✅ |
| 2 | 登记期结束后名册根不可再变（INV-7） | 边界后所有登记路径均 revert，根与人数恒定 | ✅ |
| 3 | 与独立参考实现的根一致 | 30 叶、20 叶分批两种场景下与直连 LeanIMT **逐位一致** | ✅ |
| 4 | 名册导入错误可指名定位 | 地址重复 / 承诺重复（跨批与批内）均报出具体值 | ✅ |
| 5 | 格式与静态分析 | Prettier 合规；solhint **0 error / 0 warning** | ✅ |
| 6 | 单元测试 | **91 passing**（L5 65 → P2 91，新增 26 项） | ✅ |
| 7 | 覆盖率 | 行 **100.00%**(87/87) · 语句 98.92% · 分支 97.44% | ✅ |
| 8 | 库链接与体积 | 链接依赖已登记；最大合约 3,017 B（上限 12.3%） | ✅ |

---

## 2. 交付物

```text
contracts/
├── contracts/registry/
│   └── VoterRegistry.sol           ★ 新增：地址白名单 + 承诺 Merkle 名册
├── contracts/libs/Errors.sol       新增 6 个名册相关错误（含 Slither Medium 修复引入的 `RosterRootMismatch`）
├── test/p2.voter-registry.test.ts  ★ 新增：26 项测试
└── SOLHINT.md                      ★ 新增：lint 规则裁剪说明（含两条关闭规则的技术理由）
```

**核心接口**

| 函数 | 权限 | 说明 |
| --- | --- | --- |
| `registerVoters(address[], uint256[])` | `REGISTRAR_ROLE`，**仅登记期** | 单批 ≤ 50；写入白名单并插入名册树 |
| `freezeVotersRoot()` | **无权限门槛** | 登记期结束后任何人可调用一次，固化根 |
| `requireFrozenRoot()` | 只读 | 未冻结则 revert，供 Proposal 在 `castVote` 中调用 |
| `isRegistered` / `commitmentOf` / `isEnrolled` | 只读 | 准入查询 |
| `rosterSize` / `rosterDepth` / `currentRoot` | 只读 | 树状态查询 |

---

## 3. 设计决策

### 3.1 登记有效性只比较 `block.timestamp`，禁用 `phase()`（F-01 回归点）

评审发现 F-01 指出：若用 `phase() == REGISTRATION` 作守卫，则「登记期结束 ~ 投票期开始」的
空档期（`IDLE`）会被判为可登记，**成为名册篡改窗口**。

**本合约唯一守卫是 `block.timestamp >= REGISTRATION_END`**，并在合约头部与函数注释中双重标注。
测试 `★ F-01 回归 · 登记期边界` 在四个时点（边界前 / 恰好边界 / 空档期 / 投票期）逐一验证。

### 3.2 用 `_roster._has()` 取代独立的 `commitmentUsed` 映射

LeanIMT 的 `leaves` 映射本身就是「承诺 → 下标+1」，可直接判定承诺是否已存在。

| 方案 | 每选民成本 |
| --- | --- |
| 另建 `mapping(uint256 => bool) commitmentUsed` | 一次 SSTORE ≈ **20,000 gas** |
| 复用 `_roster._has(c)` | 一次 SLOAD（冷读）≈ **2,100 gas** |

10 万选民规模下约省 **17.9 亿 gas**。**结论：不引入冗余状态。**

### 3.3 `freezeVotersRoot()` 无权限门槛

与 `finalize()` 同一设计原则：避免管理者拒不执行而导致提案卡死。
幂等性以 **revert**（`RootAlreadyFrozen`）表达而非静默成功，便于前端区分「刚成功」与「早已冻结」。

**额外守卫**：空名册（无人登记）拒绝冻结——无人登记不构成有效投票。

### 3.4 用独立布尔量 `frozen` 而非「根为 0」作哨兵

若以 `frozenRoot == 0` 表示未冻结，则「已冻结但根恰为 0」与「未冻结」不可区分。
虽然 `_root()` 在空树时返回 0 且空名册已被拒绝，但**依赖这种隐式巧合是脆弱的**，
故引入显式 `bool frozen`。

### 3.5 `VoterRegistered` 必须携带 `leafIndex`

链上只保存 `sideNodes` 与 `size`。前端要生成 ZK 证明，必须在链下**按相同插入顺序**重建同一棵树，
因此事件的顺序与下标是链下重建的唯一依据。测试已验证下标从 0 连续递增。

---

## 4. ★ 通过实测发现的两项优化

### 4.1 优化一：`_insertMany` 批处理替代逐条 `_insert`（**降 36%**）

**发现过程**：首次实现为「校验一条、插入一条」。实测 `registerVoters(50)` 为
**6,935,935 gas（138,787 / 人）**，显著高于 L5 单独测得的树插入成本（60,122 / 叶）。
差额（约 79k / 人）远超白名单写入与事件的合理开销，于是检查上游实现。

**根因**：`InternalLeanIMT._insertMany` 会缓存 `size` 与 `depth` 并**逐层构建**整棵树；
而逐条 `_insert` 每次都要重新读写这两个存储槽。

**重构**：`registerVoters` 改为三阶段——① 校验并写白名单 → ② 一次性 `_insertMany` → ③ 发事件。

| 指标 | 重构前 | 重构后 | 变化 |
| --- | --- | --- | --- |
| `registerVoters(50)` gas | 6,935,935 | **4,421,594** | **−36%** |
| 均摊每选民 | 138,787 | **88,432** | −50,355 |
| 10 万选民建树总 gas | 约 139 亿 | 约 **88 亿** | — |
| L2 量级成本（0.02 gwei / ETH 3,000） | 约 834 USD | 约 **530 USD** | — |

**代价**：批内重复承诺的检查改由本合约承担（见 4.2），因为 `_insertMany` 的批内重复
只会抛出上游笼统的 `LeafAlreadyExists()`。

### 4.2 优化二：O(n²) 批内重复检查，换取可指名的错误

**问题**：`_insertMany` 在校验循环中先写 `leaves[]` 再检查，因此能捕获批内重复，
但错误是上游的 `LeafAlreadyExists()`，**不指名是哪个承诺**。
批内重复恰是 **CSV 名册导入最常见的错误**，管理员必须能定位到具体行。

**方案**：在阶段一的校验循环内，把当前承诺与本批已处理项逐一比对，命中则抛
`CommitmentAlreadyUsed(commitment)`。

**成本论证**：`MAX_REGISTER_BATCH` 上限为 50，最坏 1,225 次比较 ≈ 1.2 万 gas，
相对批量插入节省的 **251 万 gas / 批**可忽略。**此处选择错误质量而非极致省 gas。**

### 4.3 成本估算的修正

| 来源 | 每地址 gas |
| --- | --- |
| 评审意见 F-09 的估算 | 60,000 – 100,000 |
| L5 实测（仅树插入） | 60,122 |
| **P2 实测（含白名单 + 事件 + 校验）** | **88,432** |

**F-09 的估算区间成立**，但此前未计入白名单 SSTORE 与事件开销。
`Params.MAX_REGISTER_BATCH = 50` 对应单笔约 442 万 gas，安全余量充足，**无需调整**。

### 4.4 修复：消费 `_insertMany` 返回值（Slither `unused-return` Medium 的正解）

**发现过程**：CI 接入 Slither 后，`slither . --config-file slither.config.json --fail-medium`
**退出码 255**。⚠️ 起初凭文本输出肉眼判断为「全为 Low/Informational」，属误判——
Slither 文本输出**不打印 impact**。改用 `--json` 精确分级后定位到唯一一条 Medium：

```
unused-return (Medium/Medium)
VoterRegistry.registerVoters() ignores return value by _roster._insertMany(commitments)
```

**为什么不能靠注释豁免**：上游 `_insertMany` **返回插入后的新根**，而本合约直到
`freezeVotersRoot()` 才读取固化根，该返回值业务上确实用不到。
但**直接丢弃它会让一条跨模块契约失去守卫**：

| | 载体 | 说明 |
| --- | --- | --- |
| 链上根 | `_roster.sideNodes[depth]` | 由 `_insertMany` 内部写入（源码 L217） |
| 返回值 | `currentLevelNewNodes[0]` | 同一次计算的**另一份拷贝**（源码 L219） |
| `_roster._root()` | `sideNodes[self.depth]` | 读的正是 L217 写入的那个槽 |

二者**同源，正常情况下必然相等**；但若上游改为「只返回、不再写 `sideNodes[depth]`」，
登记交易**仍会成功**，而链上根静默停留在旧值——这种漂移无法从外部察觉。

**处置**（消费而非豁免）：

```solidity
uint256 newRoot = _roster._insertMany(commitments);
if (newRoot != _roster._root()) revert RosterRootMismatch(newRoot);
```

- 新增错误 `RosterRootMismatch(uint256 returnedRoot)`（`Errors.sol`，HC-19 零引用检查通过）；
- 语义为 **fail-closed**：宁可登记失败，也不写入陈旧根；
- 成本仅 **2 次热 SLOAD**（两个槽刚被本函数写入），相对单地址 88,432 gas 可忽略。

**为什么不选「排除该探测器」**：DoD 要的是「无 High/Medium」，把探测器排除掉等于
把门禁改松；而本修复同时**确实提升**了代码对上游实现漂移的抵抗力。

**实测结果**：修复后 `--fail-medium` **退出码 0**；结果数 24 条不变
（`unused-return` 消失，代价是 `registerVoters` 的圈复杂度达到阈值，多出 1 条
**Informational** 的 `cyclomatic-complexity`）——两者都不触及 DoD 阈值。

---

## 5. 测试清单（26 项）

| 分组 | 项数 | 覆盖要点 |
| --- | --- | --- |
| 初始状态 | 3 | 未登记 / 未冻结 / `REGISTRATION_END = 0` 拒绝 / `requireFrozenRoot` revert |
| 权限 | 1 | 无 `REGISTRAR_ROLE` 被拒 |
| **★ F-01 回归** | 2 | 登记期内可登记；边界前/恰好边界/空档期/投票期四点逐一验证不可登记 |
| 入参校验 | 9 | 长度不一致、空数组、51 超限、恰好 50、承诺为 0、地址重复、承诺跨批重复、**承诺批内重复**、超域值、整笔回滚 |
| 名册树 | 3 | size/depth/root 演进、`leafIndex` 连续、`isEnrolled` |
| **★ 根一致性** | 2 | 与直连 LeanIMT 逐位一致；分批 vs 一次性登记根一致 |
| 冻结与 INV-7 | 5 | 时序、空名册、任意人可固化、幂等 revert、**冻结后根与人数恒定** |

---

## 6. 对后续阶段的影响

| 阶段 | 影响 |
| --- | --- |
| **P3（Proposal）** | `castVote` 通过 `registry.requireFrozenRoot()` 取根并与 `proof.merkleTreeRoot` 比对；**无需链上校验 Merkle 路径**（L5 结论） |
| **P4（Semaphore）** | `ISemaphoreVerifier` 接口已确认可引用 |
| **P8（部署）** | 部署顺序：`PoseidonT3` 库 → `VoterRegistry`（传入库地址）→ `ProposalFactory`；验证源码需提供库地址 |
| **P9（前端）** | 必须按 `VoterRegistered` 事件顺序重建树；本合约已保证事件携带连续 `leafIndex` |
| **P11（索引器）** | 按顺序全量消费事件，不做按键过滤（这也是关闭 `gas-indexed-events` 的依据，见 `contracts/SOLHINT.md`） |

---

## 7. 过程中修复的问题

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | 测试断言「边界前 1 秒可登记」失败 | **测试侧缺陷**：`increaseTo(t)` 后交易落在 `t+1` 区块（Hardhat 每块时间戳严格递增），实际执行在 `REGISTRATION_END`。改用 2 秒余量并加注释说明该规则 |
| 2 | solhint 报 `immutable-vars-naming` | `registrationEnd` → `REGISTRATION_END`，与 `Params.sol` 常量风格统一 |
| 3 | solhint 报 `gas-indexed-events`（3 处） | **规则关闭**：对 `uint256`/`uint64` 字段，索引（375 gas/topic）**反而贵于**数据（256 / 64 gas）；且索引器全量顺序消费事件、从不按键过滤。量化论证见 `contracts/SOLHINT.md` |
| 4 | solhint 报 `use-natspec`（5 处） | 补齐事件 `@param` 与构造器 `@notice` |
| 5 | 链接门禁拦截 `VoterRegistry` 的未登记依赖 | **门禁按设计生效**。已登记为预期链接并附技术理由（不可回避，详见 L5 报告 §6） |
| 6 | 首次实测 gas 高于 L5 预期 | 定位到 `_insert` / `_insertMany` 的存储访问差异 → 重构，降 36%（见 §4.1） |

---

## 8. 遗留与下一步

| # | 遗留项 | 移交 |
| --- | --- | --- |
| 1 | zk-kit 的 JS 侧 `lean-imt` 与链上树的一致性验证（同一序列 → 同一根） | P9（需前端环境） |
| 2 | `PoseidonT3` 在测试网上的实际部署与链接实操 | P8 |
| 3 | 名册快照（IPFS）与链上根的比对脚本 | P2 未做；**建议并入 P11 的审计证据包** |

**下一步 P3：`Proposal` 状态机（先不含 ZK）**

| 交付 | 关键点 |
| --- | --- |
| `Proposal.sol` | 四阶段 `REGISTRATION → IDLE → VOTING → REVEAL → CLOSED → FINALIZED`；`castVote` 先做**无 ZK 的占位实现**，P4 再接入证明校验 |
| 必测 | INV-2/4/5/6/7；`getCounts()` 在 `finalized` 前必须 revert（硬约束 3）；`registerVoters` 禁用 `phase()` 的同类问题在 `castVote` 中同样适用 |
