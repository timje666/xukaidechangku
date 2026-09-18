#!/usr/bin/env node
/**
 * 库链接依赖检查（部署门禁）
 *
 * 用法：node scripts/check-link-references.mjs
 *
 * 检查什么：
 *   扫描 hardhat artifacts，找出所有**需要外部库链接**的合约。
 *   若某合约的 `linkReferences` 非空，则部署前必须先部署对应库合约并传入库地址，
 *   否则部署会失败或产出不可用的字节码。
 *
 * 为什么需要它：
 *   本项目刻意选用 `InternalLeanIMT`（internal 函数，编译期内联）而非 `LeanIMT`
 *   （public 函数，产生库链接引用），目的是让 VoterRegistry 保持**单合约独立部署**，
 *   避免「库地址 → 合约地址」的部署顺序依赖，同时简化区块浏览器的源码验证
 *   （验证含链接的合约需要额外提供库地址）。
 *
 *   一旦有人误用 public 版库，部署脚本会在 P8 才暴露问题。本脚本把它提前到编译后立即拦截。
 *
 * 退出码：存在未登记的链接引用时为 1。
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

/**
 * 已登记的**预期**库链接依赖。
 *
 * 规则：每一条都必须给出可验证的技术理由，且**必须是业务上无法回避的**。
 * 未被登记且存在链接引用的合约一律判为失败——目的是拦住「本可内联却误用了
 * public 版库」这类会显著增加部署复杂度的写法。
 */
const EXPECTED_LINKS = [
  {
    contract: "DependencyProbe",
    lib: "PoseidonT3",
    reason:
      "L5 实测结论：poseidon-solidity 的 PoseidonT3.hash 是 public 函数，" +
      "而任何在链上维护 Semaphore 兼容 Merkle 树的合约都必须调用它来哈希内部节点。" +
      "即使选用 InternalLeanIMT（internal，已内联）也无法消除该依赖。" +
      "⇒ P8 部署脚本必须「先部署 PoseidonT3 → 再部署业务合约并传入库地址」，" +
      "区块浏览器验证时需一并提供库地址。",
  },
];

/**
 * 已登记豁免：允许存在库链接但**不要求**在部署时链接的合约。
 * 业务合约（contracts/ 下自研部分）一律不允许进入此列表。
 */
const EXEMPTIONS = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".json") && !name.endsWith(".dbg.json")) out.push(p);
  }
  return out;
}

const ROOTS = ["artifacts/contracts", "artifacts"];
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

const linked = [];
const clean = [];
const oversized = [];
const LIMIT = 24576;

for (const file of walk(root)) {
  let art;
  try {
    art = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  const bc = art.deployedBytecode ?? "0x";
  if (!bc || bc === "0x") continue;

  const name = art.contractName ?? basename(file, ".json");
  const refs = art.linkReferences ?? {};
  const libs = [];
  for (const [srcFile, libsInFile] of Object.entries(refs)) {
    for (const libName of Object.keys(libsInFile)) {
      libs.push(`${libName} (${srcFile})`);
    }
  }

  if (libs.length > 0) linked.push({ name, libs });
  else clean.push(name);

  const size = (bc.length - 2) / 2;
  if (size > LIMIT) oversized.push({ name, size });
}

console.log("库链接依赖检查");
console.log(`  已扫描合约: ${clean.length + linked.length}`);

if (clean.length) {
  console.log(`  ✅ 无需链接（可独立部署）: ${clean.length} 个`);
  for (const n of clean) console.log(`       ${n}`);
}

if (linked.length) {
  console.log("");
  console.log(`  ⚠️ 需要外部库链接: ${linked.length} 个`);
  for (const { name, libs } of linked) {
    const expected = EXPECTED_LINKS.some((e) => e.contract === name);
    const exempt = EXEMPTIONS.some((e) => e.contract === name);
    const mark = expected ? "ℹ️ 已登记" : exempt ? "ℹ️ 已豁免" : "✗ 未登记";
    console.log(`       ${mark}  ${name}`);
    for (const l of libs) console.log(`           → ${l}`);
  }
}

if (oversized.length) {
  console.log("");
  console.log("  ✗ 超过 EIP-170 上限:");
  for (const { name, size } of oversized) console.log(`       ${name}: ${size} B`);
}

console.log("");
const unexpected = linked.filter((l) => !EXPECTED_LINKS.some((e) => e.contract === l.name));
const exempted = linked.filter((l) => EXEMPTIONS.some((e) => e.contract === l.name));

if (linked.length > 0) {
  for (const e of EXPECTED_LINKS) {
    if (linked.some((l) => l.name === e.contract)) {
      console.log(`  ℹ️ 预期链接 [${e.contract}] → ${e.lib}`);
      console.log(`     ${e.reason}`);
    }
  }
}

const problems = unexpected.length + oversized.length;
if (problems === 0) {
  console.log("");
  console.log("✓ 全部合约的库链接依赖均已登记，且无超限合约");
  if (linked.length > 0) {
    console.log("");
    console.log("⚠️ 部署顺序要求（P8 必须遵守）：");
    console.log("   1. 先部署 PoseidonT3 库合约并记录地址");
    console.log("   2. 再部署依赖它的业务合约，构造工厂时传入 { libraries: { PoseidonT3: <addr> } }");
    console.log("   3. 区块浏览器验证业务合约时，一并提供 PoseidonT3 地址");
  }
} else {
  if (unexpected.length > 0) {
    console.error("✗ 存在**未登记**的库链接依赖：");
    for (const { name, libs } of unexpected) {
      console.error(`     ${name} → ${libs.join(", ")}`);
    }
    console.error("   若为业务上不可回避，请在 EXPECTED_LINKS 中登记并说明理由；");
    console.error("   若是误用了 public 版库，请改用 internal 版本以避免部署复杂度。");
  }
  if (oversized.length > 0) {
    console.error("✗ 存在超过 EIP-170 上限（24576 B）的合约");
  }
  process.exit(1);
}

if (exempted.length > 0) {
  for (const e of EXEMPTIONS) console.log(`  豁免理由 [${e.contract}]: ${e.reason}`);
}
