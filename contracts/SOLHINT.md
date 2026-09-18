# Solhint 规则裁剪说明

本项目的 `.solhint.json` 继承 `solhint:recommended`，并**仅关闭两条规则**。
每条关闭都必须给出可验证的技术理由，不接受「嫌麻烦」。

---

## `gas-strict-inequalities` —— 已关闭

**规则主张**：把 `a >= b` 改写为 `a > b` 形式，因为 `>=` 会多编译出一个 `ISZERO` 操作码。

**关闭理由**：该改写**会改变语义**。本项目的比较全部有明确边界含义，例如：

```solidity
// Params.sol —— 必须是「严格小于下限才拒绝」，改成 > 会放行等于下限的非法配置
if (registrationEnd - now_ < MIN_REGISTRATION_WINDOW) return false;

// VoterRegistry.sol —— 必须是 >=，因为 registrationEnd 当刻即不可再登记
if (block.timestamp >= REGISTRATION_END) revert RegistrationClosed();
```

为省一个约 3 gas 的操作码而扭曲边界语义，在本项目（安全优先于微优化）中不可接受。

---

## `gas-indexed-events` —— 已关闭

**规则主张**：事件字段应加 `indexed`，以便链下过滤，且更省 gas。

**关闭理由（量化）**：

| 写法 | 成本 |
| --- | --- |
| 作为 data 存储，`uint256`（32 字节） | 32 × 8 = **256 gas** |
| 作为 indexed topic 存储，`uint256` | **375 gas / topic** |
| 作为 data 存储，`uint64`（8 字节） | 8 × 8 = **64 gas** |
| 作为 indexed topic 存储，`uint64` | **375 gas / topic** |

**对 `uint256` / `uint64` 字段，加索引反而更贵**（分别为 +119 gas 与 +311 gas）。
该规则真正有价值的场景是 `string` / `bytes` / 数组（索引只存 32 字节哈希），本项目事件不含这类字段。

**且无查询收益**：本项目的索引器（P11）**按顺序全量消费事件**以重建 Merkle 树，
从不按键过滤。为事件字段建索引只增加日志成本，不产生任何查询便利。

**已保留的索引**：仅 `VoterRegistered.leafIndex` 与 `votersRoot` 等**用于链下定位**的字段保留 `indexed`。

---

## 已修正而非关闭的规则

以下规则产出的告警**已全部修正**，未关闭：

| 规则 | 处置 |
| --- | --- |
| `use-natspec` | 补齐生产合约的 `@title` / `@author` / `@notice` / `@param` / `@return`（P1 补 34 处，P2 补 5 处） |
| `immutable-vars-naming` | 将 `registrationEnd` 重命名为 `REGISTRATION_END`，与 `Params.sol` 常量风格一致 |
| `gas-custom-errors` | 全部错误均为 custom error，无 `require` 字符串 |
| `compiler-version` | 固定 `0.8.24` |

---

## 例外范围与硬约束的关系

`.solhintignore` 排除了 `contracts/harness/` 与 `contracts/probe/`（测试夹具与依赖探针，非业务合约）。

> **【重要】** 硬约束守卫测试（`test/p1.hard-constraints.test.ts`）**不读取** `.solhintignore`。
> 它自行遍历全部 `.sol` 文件，因此 `harness/` 与 `probe/` **同样受**全部禁用项扫描约束
> （禁暂停类角色 / `selfdestruct` / `delegatecall` / `tx.origin` / `require` 字符串 / `assembly`）。
