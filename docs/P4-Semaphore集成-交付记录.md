# P4 · Semaphore 集成（ZK 证明校验）· 交付记录

| 项 | 内容 |
| --- | --- |
| 阶段 | P4（见 `区块链去中心化投票系统-实现方案-v2.md` §10） |
| 状态 | **已完成**，但存在 **1 项实测缺口**（见 §4） |
| 执行日期 | 2026-09-18 |
| 前置 | P0–P3、L5 依赖验证 |

---

## 1. DoD 验证结果

| # | 完成标准 | 实测 | 判定 |
| --- | --- | --- | --- |
| 1 | `castVote(ZKProof)` 接入 Semaphore 验证器 | 使用官方 `SemaphoreVerifier`，未手写 | ✅ |
| 2 | 伪造证明 100% revert | 小整数 points、随机大整数 points 两类均被拒 | ✅ |
| 3 | 错误 Merkle 根 revert | `RootMismatch()` | ✅ |
| 4 | 错误 scope revert | `InvalidScope()`；双向跨提案重放均被拒 | ✅ |
| 5 | **F-05 写入滞后**（INV-9） | 验证失败后 `_nullifierUsed` 仍为 false，`nullifierCount` 不变 | ✅ |
| 6 | 名册未冻结时拒绝投票 | 由 `requireFrozenRoot()` 抛出 `RootNotFrozen()` | ✅ |
| 7 | `_hash` 与上游逐值一致 | 5 组取值与 JS 参考实现逐一相等 | ✅ |
| 8 | 公开信号组成正确 | strictMode 替身按上游公式交叉校验，含 2 项反自检 | ✅ |
| 9 | 格式 / 静态分析 / 编译 / 链接 / 体积 | Prettier 合规；solhint **0 error / 0 warning**；verify 全链路通过 | ✅ |
| 10 | 单元测试 | **151 passing**（P3 125 → P4 151，新增 26 项） | ✅ |
| 11 | 覆盖率 | 行 **100.00%**(173/173) · 语句 98.75% · 分支 97.97% | ✅ |
| 12 | **真实证明端到端接受** | ❌ **无法在本机验证**（见 §4） | ⚠️ |

---

## 2. 交付物

```text
contracts/
├── contracts/proposal/Proposal.sol          ★ 新增 castVote / _verifySemaphoreProof / _hash
├── contracts/interfaces/IVoterRegistry.sol  ★ 新增：名册最小读取接口
├── contracts/deploy/CompilationAnchors.sol  ★ 新增：确保验证器 artifact 产出
├── contracts/harness/MockVerifier.sol       ★ 新增：ZK 验证器测试替身（含 strictMode）
├── contracts/harness/ProposalHarness.sol    新增 hashScalar（暴露 _hash 供断言）
└── test/p4.semaphore.test.ts                ★ 新增：26 项测试

scripts/
└── check-contract-size.mjs                  ★ 扩展：纳入将被部署的第三方合约
```

---

## 3. ★ 本阶段最关键的技术事实

### 3.1 公开信号的构造 —— 最容易写错、且本机无法端到端验证

查阅 Semaphore 官方 `Semaphore.sol` 得到的事实：

```solidity
// 官方调用验证器的方式
verifier.verifyProof(
    [points[0], points[1]],
    [[points[2], points[3]], [points[4], points[5]]],
    [points[6], points[7]],
    [merkleTreeRoot, nullifier, _hash(message), _hash(scope)],   // ← 后两项要先哈希
    merkleTreeDepth
);

// 官方的标量哈希
function _hash(uint256 message) private pure returns (uint256) {
    return uint256(keccak256(abi.encodePacked(message))) >> 8;
}
```

**三个必须照做的点**：

| # | 事实 | 若写错会怎样 |
| --- | --- | --- |
| 1 | `message` 与 `scope` **必须先哈希**再入电路 | 直接传原值 ⇒ **所有合法证明都被拒** |
| 2 | `merkleTreeDepth` 是**独立参数**，不在 `pubSignals` 里 | 参数错位 ⇒ 验证永远失败 |
| 3 | `points[8]` 到 `pA/pB/pC` 的拆包顺序固定（0-1 / 2-3,4-5 / 6-7） | 顺序错 ⇒ 验证永远失败 |

这三类错误的共同点是：**在本机不产生任何报错**（因为无法生成合法证明来发现它们），
要到真实环境才会表现为「所有人都投不了票」。

### 3.2 应对：把「无法验证」的约束变成可断言的事

| 手段 | 做法 |
| --- | --- |
| **暴露 `_hash`** | 可见性由 `private` 改为 `internal`，经 `ProposalHarness.hashScalar()` 暴露，与 JS 参考实现逐值比对（5 组取值） |
| **strictMode 替身** | `MockVerifier` 在 strictMode 下**按上游公式自行重算** `_hash(message)` / `_hash(scope)`，与 Proposal 传来的 `pubSignals` 逐项比对。漏哈希、顺序颠倒即返回 false ⇒ 测试失败 |
| **反自检** | 刻意把期望值写错，断言 strictMode 确实返回 false —— 否则「strictMode 恒真」会让整个机制静默失效 |

### 3.3 测试替身的存在理由与误用防护

`MockVerifier` 可对任意证明返回 true，**若被误用为真实验证器，系统对伪造选票毫无察觉**。

防护措施：

| 措施 | 说明 |
| --- | --- |
| 置于 `contracts/harness/` | 与业务合约物理隔离，不参与部署产物 |
| 合约头明确标注「严禁部署到任何非测试网络」 | — |
| 部署脚本需断言 `Proposal.VERIFIER` 为官方验证器 | **P8 必做项** |
| `CompilationAnchors` 保证官方验证器的 artifact 始终可用 | 降低「顺手用替身顶替」的诱因 |

---

## 4. ⚠️ 实测缺口：真实证明的端到端接受无法在本机验证

### 4.1 事实

| 项 | 情况 |
| --- | --- |
| 生成真实 Groth16 证明需要 | 电路产物 `.wasm` / `.zkey`（数 MB） |
| 产物是否随 npm 包分发 | **否**。`@zk-kit/artifacts` 解包后仅 **48,610 字节 / 76 个文件**，纯代码 |
| 产物实际来源 | `snark-artifacts.hugomrd.dev`（`@zk-kit/artifacts` 的下载目标） |
| 该域名可达性 | **不可达（curl 返回 000）** |
| 绕过尝试 | `cdn.jsdelivr.net/gh/...` 代理 GitHub 仓库可行，但仓库内**不含** `.zkey`/`.wasm`（`packages/proof/artifacts` 返回 404） |

### 4.2 因此**未被验证**的内容

| # | 未验证项 | 影响 |
| --- | --- | --- |
| L4-1 | **真实合法证明能否被接受** | 若 §3.1 的三点中有实现错误，本机全部测试仍会通过 |
| L4-2 | 真实验证器的 gas（`castVote` 实测值未含配对校验） | 成本估算偏低 |
| L4-3 | 电路与合约对 `message` 语义的理解是否一致 | 需真机确认 |

### 4.3 已做的风险缓解

- §3.2 的三项手段覆盖了 L4-1 的主要成因（哈希缺失、顺序颠倒）
- **残余风险**：`points` 拆包顺序（3.1 第 3 点）。该错误的表现是「所有证明被拒」，
  属**醒目失败**而非静默失败 —— 首次真机联调会立刻暴露，不会潜伏
- L4-2 的影响：成本估算需在 P12（测试网灰度）后用实测修正

### 4.4 关闭条件（移交 P12）

| 关闭路径 | 说明 |
| --- | --- |
| A（推荐） | 在可访问 `snark-artifacts.hugomrd.dev` 的环境生成一份证明样本，作为 fixture 提交，测试回放 |
| B | 在 CI（Linux + 外网）中安装 `@semaphore-protocol/proof` 并现场生成证明 |
| C | 将电路产物内网镜像后本地生成 |

**在 L4-1 关闭前，不得进入 P14（正式上线）。**

---

## 5. 实测数据

| 操作 | gas | 说明 |
| --- | --- | --- |
| `castVote`（**替身验证器**） | 110,100 – 119,007 | ⚠️ **不含真实配对校验**，是**下界** |
| `SemaphoreVerifier` 部署 | 3,722,180 | 一次性 |
| `Proposal` 部署 | 约 1,624,253 | 一次性 |
| `Proposal` 运行时代码 | 7,915 B | 占 EIP-170 上限 32.2% |

**真实 `castVote` 的 gas 未测得**。P3 记录的 25–35 万为估算值，需在 L4-1 关闭后实测修正。

### 5.1 部署体积（含第三方合约）

| 合约 | deployedBytecode | 占上限 |
| --- | --- | --- |
| **PoseidonT3**（依赖） | 16,852 B | 68.6% |
| **SemaphoreVerifier**（依赖） | 15,886 B | 64.6% |
| **PoseidonT4**（依赖） | 12,590 B | 51.2% |
| Proposal | 7,915 B | 32.2% |

体积门禁已扩展为**一并检查将被部署的第三方合约** —— 此前只扫本仓合约，会漏掉它们。

---

## 6. 过程中发现并修复的工程问题

### 6.1 `new ChildContract()` 会让工厂超出 EIP-170（实测 30,708 字节）

原先计划用链上 `VerifierFactory.deployVerifier()` 部署验证器。实测该工厂
**30,708 字节，超过 24,576 上限，无法部署** —— 因为 `new SemaphoreVerifier()`
把验证器的**创建字节码整体嵌入**了工厂字节码。

**修复**：链上工厂改为空锚点（只 import、不含 `new`），验证器改由 **P8 链下脚本**直接 `deploy()`。

> 顺带确认：`SemaphoreVerifier` 自身的 deployedBytecode 为 **15,886 B**，可部署。
> （EIP-170 限制运行时字节码；EIP-3860 限制 initcode 为 49,152 B，其 30,449 B 的创建字节码亦合规。）

### 6.2 `SemaphoreVerifierKeyPts` 不需要链接

该库只含 `private constant` 数据与 `internal pure` 的 `getPts()`，编译期内联。
**P8 的部署顺序因此只需**：库（PoseidonT3/T4）→ 验证器 → 业务合约。

### 6.3 verifier 调用失败模式的统一收敛（安全网）

真实验证器对畸形点可能**直接 revert**（`ecPairing` 预编译失败），而非返回 false。
用户会拿到不可读的底层错误，前端无法映射。

**修复**：用 `try/catch` 包裹验证器调用，两种失败模式统一收敛为
`InvalidProof()`。对应测试 `★ 验证器直接 revert 时，必须被收敛为 InvalidProof`。

> 该 `catch` 分支一度**完全未被测试**（覆盖率报告暴露）—— 而它正是安全网本身。
> 为此给测试替身加了 `revertMode` 开关来触达。

### 6.4 新增必填字段导致 P3 测试全线中断

`ProposalInit` 增加 `verifier` 后，P3 的 fixture 未提供该字段，
导致 **35 项 P3 测试失败**。

**处置**：更新 P3 fixture 注入 `MockVerifier` 地址，并加注释说明该字段自 P4 起为必填。

> **教训**：给共享结构体加必填字段属**破坏性变更**，必须同步检查全部调用方。
> `ProposalInit` 后续还要被 P7 的 Factory 使用，届时需同样检查。

### 6.5 NatSpec 的 `@包名` 陷阱复发（第二次）

在注释里写 `@zk-kit/artifacts` 再次触发 `DocstringParsingError`。

**处置**：改写措辞，并**新增硬约束 HC-17** —— 扫描全部 `.sol`，
`///` 或 `*` 注释行中出现 `@xxx/` 形式（且非合法 NatSpec 标签）即失败。
含自检用例验证规则本身有效。

---

## 7. 遗留与下一步

| # | 遗留项 | 移交 | 阻断性 |
| --- | --- | --- | --- |
| **L4-1** | **真实证明的端到端接受未验证** | P12（见 §4.4） | **阻断 P14 上线** |
| L4-2 | 真实 `castVote` gas 未测得 | P12 | 非阻断 |
| L4-3 | P8 部署脚本需断言 `VERIFIER` 非测试替身 | P8 | — |
| L4-4 | `ProposalInit` 增字段的破坏性影响需在 P7 复查 | P7 | — |

**下一步 P5：`MinimalForwarder` 中继（ERC-2771）**

| 交付 | 关键点 |
| --- | --- |
| `MinimalForwarder.sol` | EIP-712 类型哈希必须覆盖 `from/to/value/gas/nonce/deadline/**keccak256(data)**`，并校验 `deadline` 与 `nonce`（评审 F-10，硬约束 4） |
| 必测 | 签名重放（同签名换 calldata）、跨提案重放、过期签名、nonce 复用 —— **全部必须被拒** |
| 关联 | 全匿名性的必要条件（C1）；其正确性直接决定「sender 与选民解耦」是否成立 |
