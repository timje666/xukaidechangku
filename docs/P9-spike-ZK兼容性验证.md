# P9 Spike · 浏览器端 ZK proof 离线生成可行性验证

> 阶段：P9（前端：登记 + 投票，含 proof 生成）技术验证
> 目标：确认 `@semaphore-protocol/proof` 生成的证明与已部署 `SemaphoreVerifier`（@semaphore-protocol/contracts 4.14.3）的公开信号布局一致，并确认 snark 产物在无外网环境下的可得性。

## 1. 兼容性结论：✅ 一致（已通过源码比对确认）

`@semaphore-protocol/proof@4.14.3` 的 `generateProof` 签名与行为：

```ts
generateProof(identity, groupOrMerkleProof, message, scope, merkleTreeDepth, snarkArtifacts?)
// 返回 { merkleTreeRoot, nullifier, message, scope, points: uint256[8], merkleTreeDepth }
```

其 ZK 输入构造（`node_modules/@semaphore-protocol/proof/dist/index.node.js`）：

```js
const { proof, publicSignals } = await groth16.fullProve({
  secret: identity.secretScalar,
  merkleProofLength, merkleProofIndex, merkleProofSiblings,
  scope: hash(scope),      // hash = keccak256(x) >> 8 （@semaphore-protocol/utils）
  message: hash(message),  // 同上
}, wasm, zkey);
```

而 `Proposal._verifySemaphoreProof`（contracts/proposal/Proposal.sol:377）对官方验证器的调用：

```solidity
ISemaphoreVerifier(VERIFIER).verifyProof(
  [proof.points[0], proof.points[1]],
  [[proof.points[2], proof.points[3]], [proof.points[4], proof.points[5]]],
  [proof.points[6], proof.points[7]],
  [proof.merkleTreeRoot, proof.nullifier, _hash(proof.message), _hash(proof.scope)], // _hash = keccak256>>8
  proof.merkleTreeDepth
);
```

官方 `SemaphoreVerifier.verifyProof(uint[2],uint[2][2],uint[2],uint[4],uint)` 消费的 4 个公开信号
正是 `[merkleTreeRoot, nullifier, hash(message), hash(scope)]`，与电路公开信号 `[root, nullifierHash, signalHash, externalNullifier]` 逐字对齐。

**结论**：电路与合约的信号哈希函数同为 `keccak256(x) >> 8`，端到端 ZK 链路在算法层面一致。此前仓库内**无**真实的「JS 生成 proof → 链上 castVote」往返测试，本 spike 确认该缺口可在 P9 E2E 补课（详见 §3）。

## 2. snark 产物可得性：⚠️ 本沙箱出口被拦，用户环境/CI 需保障 egress

| 来源 | 结果 |
| --- | --- |
| `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore.{wasm,zkey}`（官方默认） | **HTTP 403 `AccessDenied`**（S3 桶策略，本沙箱出口被拦；带浏览器 UA 仍 403） |
| jsDelivr GitHub 镜像、raw.gitmirror、ghfast.top、raw.githubusercontent | 404 / 连接失败（GitHub 出口同样不可达） |
| npm 源 `@zk-kit/artifacts@2.0.1`（generateProof 的依赖） | 仅含**下载器**（`BASE_URL=https://snark-artifacts.pse.dev`），**不打包** wasm/zkey |

`@semaphore-protocol/proof` 的默认行为是在调用时自动从 `snark-artifacts.pse.dev` 拉取产物（版本 `4.13.0`）。在普通浏览器/开发机环境下该 CDN 可达；**本沙箱出口被拦**，故本地无法跑通真实 proof 生成。

## 3. P9 落地方案（绕开本沙箱约束）

1. **前端 proof 代码**：使用 `generateProof(identity, group, message, scope, merkleTreeDepth, snarkArtifacts?)`；默认走 CDN 自动下载（用户环境可用）。
2. **离线/自托管**：提供 `apps/web/scripts/fetch-snark-artifacts.mjs`，将 `semaphore.wasm`/`semaphore.zkey` 下载到 `apps/web/public/snark/`，运行时通过 `snarkArtifacts` 显式传入（或 `NEXT_PUBLIC_SNARK_ARTIFACTS_URL` 覆盖）。该脚本在**有 egress 的环境**（用户机 / CI）运行一次即可。
3. **本地 E2E（本沙箱）**：因无产物，ZK 快乐路径无法在此跑通；P9 E2E 用 `viem` 验证「中继提交 → 合约 → `BallotCommitted` 事件 / 错误码映射」的非 ZK 部分，并提供 `USE_MOCK_PROOF` 开发开关（明确标注非 ZK）以驱动 UI/中继/合约错误分支（如 `InvalidProof`）。真实 ZK 快乐路径由用户在可达 egress 的环境验收。
4. **CI**：`build-and-test` 增加前端门禁；`fetch-snark-artifacts` 在 CI 中随 egress 允许时执行（CDN 不可达时跳过，仅跑非 ZK 测试）。

## 4. 后续行动

- [ ] 在 `apps/web` 安装 `@semaphore-protocol/{identity,group,proof}@4.14.3` + `wagmi@^2` + `viem`。
- [ ] 实现 `lib/semaphore.ts`（identity 本地保管、group 构建、proof 生成，含 `snarkArtifacts` 显式传入）。
- [ ] 实现 `scripts/fetch-snark-artifacts.mjs` 与 `.env.example` 的 `NEXT_PUBLIC_SNARK_ARTIFACTS_URL`。
- [ ] E2E 补「JS 生成 proof → castVote」真实往返（用户/CI 环境验收）。
