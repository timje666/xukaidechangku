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
  rows.push({ name: art.contractName ?? basename(file, ".json"), size, file });
}

if (rows.length === 0) {
  console.log("未发现可部署合约字节码（可能仅含 interface / library），跳过体积检查");
  process.exit(0);
}

rows.sort((a, b) => b.size - a.size);

console.log("合约体积（deployedBytecode）");
let failed = false;
for (const r of rows) {
  const ratio = ((r.size / LIMIT) * 100).toFixed(1);
  const flag = r.size > LIMIT ? "✗ 超限" : "✓";
  if (r.size > LIMIT) failed = true;
  console.log(`  ${flag} ${r.name.padEnd(28)} ${String(r.size).padStart(6)} B  (占上限 ${ratio}%)`);
}

if (failed) {
  console.error(`✗ 存在超过 ${LIMIT} 字节的合约，无法部署（EIP-170）`);
  process.exit(1);
}
console.log(`✓ 全部合约体积在 ${LIMIT} 字节以内`);
