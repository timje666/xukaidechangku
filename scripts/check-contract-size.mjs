#!/usr/bin/env node
/**
 * 合约体积检查（CI 门禁 4）
 *
 * 用法：node scripts/check-contract-size.mjs [上限字节数，默认 24576]
 * EIP-170 规定部署字节码上限为 24576 字节（24 KiB）。
 * 超过此上限的合约无法部署到主网，必须在 CI 阶段拦截。
 *
 * 说明：原方案使用 `forge build --sizes`。因 GitHub 不可达无法安装 Foundry，
 *       P0 改为直接扫描 hardhat artifacts 的 deployedBytecode 长度。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const LIMIT = Number(process.argv[2] ?? 24576);
const ROOTS = ["artifacts/contracts", "artifacts"];

/**
 * 需要一并检查体积的**第三方合约**（会被真实部署）。
 *
 * 为什么必须单独列出：本脚本默认只扫 `artifacts/contracts`（本仓合约），
 * 但 Semaphore 验证器是从依赖包部署的独立合约——它同样受 EIP-170 约束，
 * 超限即无法部署。若不检查，问题会推迟到 P8 部署时才暴露。
 *
 * 路径为 artifact 文件相对于 `artifacts/` 的路径。
 */
const DEPLOYED_DEPENDENCIES = [
  {
    artifactPath: "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol/SemaphoreVerifier.json",
    name: "SemaphoreVerifier",
    note: "ZK 证明验证器，P8 需部署",
  },
  {
    artifactPath: "poseidon-solidity/PoseidonT3.sol/PoseidonT3.json",
    name: "PoseidonT3",
    note: "Merkle 树哈希库，P8 需部署",
  },
  {
    artifactPath: "poseidon-solidity/PoseidonT4.sol/PoseidonT4.json",
    name: "PoseidonT4",
    note: "选票承诺哈希库，P8 需部署",
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (name.endsWith(".json") && !name.endsWith(".dbg.json")) {
      out.push(p);
    }
  }
  return out;
}

let root = null;
for (const r of ROOTS) {
  const p = resolve(process.cwd(), r);
  if (existsSync(p)) {
    root = p;
    break;
  }
}

if (!root) {
  console.error("✗ 未找到 artifacts 目录，请先执行 npm run build");
  process.exit(1);
}

const rows = [];
for (const file of walk(root)) {
  let art;
  try {
    art = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const bc = art.deployedBytecode ?? "0x";
  if (!bc || bc === "0x") continue; // 接口 / 库 / 无字节码
  const size = (bc.length - 2) / 2;
  rows.push({ name: art.contractName ?? basename(file, ".json"), size, file, dep: false });
}

// 追加第三方部署合约
const artifactsRoot = resolve(process.cwd(), "artifacts");
for (const dep of DEPLOYED_DEPENDENCIES) {
  const p = join(artifactsRoot, dep.artifactPath);
  if (!existsSync(p)) {
    console.error(`✗ 未找到已登记第三方合约的 artifact：${dep.artifactPath}`);
    console.error("   若依赖已升级导致路径变化，请更新 DEPLOYED_DEPENDENCIES。");
    process.exit(1);
  }
  const art = JSON.parse(readFileSync(p, "utf8"));
  const bc = art.deployedBytecode ?? "0x";
  const size = (bc.length - 2) / 2;
  rows.push({ name: dep.name, size, file: dep.artifactPath, dep: true, note: dep.note });
}

if (rows.length === 0) {
  console.log("未发现可部署合约字节码（可能仅含 interface / library），跳过体积检查");
  process.exit(0);
}

rows.sort((a, b) => b.size - a.size);

console.log("合约体积（deployedBytecode，含将被部署的第三方合约）");
let failed = false;
for (const r of rows) {
  const ratio = ((r.size / LIMIT) * 100).toFixed(1);
  const flag = r.size > LIMIT ? "✗ 超限" : "✓";
  if (r.size > LIMIT) failed = true;
  const tag = r.dep ? " [依赖]" : "";
  console.log(`  ${flag} ${(r.name + tag).padEnd(32)} ${String(r.size).padStart(6)} B  (占上限 ${ratio}%)`);
  if (r.note) console.log(`       ${r.note}`);
}

if (failed) {
  console.error(`✗ 存在超过 ${LIMIT} 字节的合约，无法部署（EIP-170）`);
  process.exit(1);
}
console.log(`✓ 全部合约体积在 ${LIMIT} 字节以内`);
