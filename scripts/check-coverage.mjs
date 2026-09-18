#!/usr/bin/env node
/**
 * 覆盖率门槛检查（CI 门禁 3）
 *
 * 用法：node scripts/check-coverage.mjs [阈值百分比，默认 90]
 * 读取 hardhat coverage 生成的 coverage.json，计算全局行/语句/分支覆盖率。
 *
 * 说明：原方案使用 forge coverage。因 GitHub 不可达无法安装 Foundry，
 *       P0 改用 solidity-coverage（随 hardhat-toolbox 提供）作为等价替代。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const threshold = Number(process.argv[2] ?? 90);
const CANDIDATES = ["coverage.json", "contracts/coverage.json"];

let coveragePath = null;
for (const c of CANDIDATES) {
  const p = resolve(process.cwd(), c);
  if (existsSync(p)) {
    coveragePath = p;
    break;
  }
}

if (!coveragePath) {
  console.error(`✗ 未找到 coverage.json（已查找: ${CANDIDATES.join(", ")}）`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(coveragePath, "utf8"));

let lf = 0;
let lh = 0;
let bf = 0;
let bh = 0;
let sf = 0;
let sh = 0;

for (const [file, data] of Object.entries(raw)) {
  // 只统计项目自身合约，跳过依赖与测试夹具
  if (file.includes("node_modules/")) continue;
  if (file.includes("/harness/") || file.includes("\\harness\\")) continue;

  const l = data.l ?? {};
  for (const v of Object.values(l)) {
    lf += 1;
    if (Number(v) > 0) lh += 1;
  }

  const b = data.b ?? {};
  for (const arr of Object.values(b)) {
    for (const v of arr) {
      bf += 1;
      if (Number(v) > 0) bh += 1;
    }
  }

  const s = data.s ?? {};
  for (const v of Object.values(s)) {
    sf += 1;
    if (Number(v) > 0) sh += 1;
  }
}

const pct = (hit, total) => (total === 0 ? 100 : (hit / total) * 100);
const linePct = pct(lh, lf);
const branchPct = pct(bh, bf);
const stmtPct = pct(sh, sf);

const fmt = (n) => `${n.toFixed(2)}%`;
console.log("覆盖率统计（不含依赖与测试夹具）");
console.log(`  行覆盖   ${fmt(linePct)}  (${lh}/${lf})`);
console.log(`  语句覆盖 ${fmt(stmtPct)}  (${sh}/${sf})`);
console.log(`  分支覆盖 ${fmt(branchPct)}  (${bh}/${bf})`);
console.log(`  门槛     ${threshold}%`);

let failed = false;
if (linePct < threshold) {
  console.error(`✗ 行覆盖率 ${fmt(linePct)} < 门槛 ${threshold}%`);
  failed = true;
}
if (branchPct < 85) {
  console.error(`✗ 分支覆盖率 ${fmt(branchPct)} < 门槛 85%`);
  failed = true;
}

if (failed) {
  console.error("覆盖率门槛未通过");
  process.exit(1);
}
console.log("✓ 覆盖率门槛通过");
