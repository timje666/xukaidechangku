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
 * 已登记的**预期**库（按库名登记，而非按合约登记）。
 *
 * 为什么按库而非按合约：
 *   链接依赖来自「调用了哪个 public 库函数」，与调用方是哪份合约无关。
 *   按合约登记会随合约数量线性膨胀（Proposal、ProposalHarness、VoterRegistry、
 *   DependencyProbe…），且新增合约时反复触发误报。
 *   按库登记只需在**引入新库**时更新一次，仍能拦住真正需要警惕的情况。
 *
 * 规则：每条都必须给出可验证的技术理由，且必须是业务上无法回避的。
 * 未被登记却出现在 linkReferences 中的库一律判为失败。
 */
const EXPECTED_LIBS = [
  {
    lib: "PoseidonT3",
    reason:
      "Semaphore 兼容 Merkle 树的 2 输入哈希。poseidon-solidity 的 PoseidonT3.hash 是 public，" +
      "无法内联。VoterRegistry 每次 _insert 与 DependencyProbe 都依赖它。",
  },
  {
    lib: "PoseidonT4",
    reason:
      "选票承诺的 3 输入哈希：Poseidon4([ballotMask, salt, SCOPE])。" +
      "第三个输入是提案域分隔（SCOPE 全局唯一），用于防止同一选民在不同提案间因盐复用而被关联。" +
      "若改用 2 输入版本会失去该防护，故必须引入 T4。" +
      "同样因 hash 是 public 而无法内联，链接不可回避。",
  },
];

/** 已登记豁免：允许存在库链接但无需在部署时链接的合约（业务合约不得进入此列表） */
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
const seenLibs = new Set();
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
      libs.push({ lib: libName, src: srcFile });
      seenLibs.add(libName);
    }
  }

  if (libs.length > 0) linked.push({ name, libs });
  else clean.push(name);

  const size = (bc.length - 2) / 2;
  if (size > LIMIT) oversized.push({ name, size });
}

const knownLib = (n) => EXPECTED_LIBS.some((e) => e.lib === n);

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
    const bad = libs.filter((l) => !knownLib(l.lib));
    console.log(`       ${bad.length === 0 ? "ℹ️ 已登记" : "✗ 含未登记库"}  ${name}`);
    for (const l of libs) {
      console.log(`           → ${l.lib}${knownLib(l.lib) ? "" : "  ← 未登记"}`);
    }
  }
}

if (oversized.length) {
  console.log("");
  console.log("  ✗ 超过 EIP-170 上限:");
  for (const { name, size } of oversized) console.log(`       ${name}: ${size} B`);
}

console.log("");
const unknownLibs = [...seenLibs].filter((n) => !knownLib(n));

if (unknownLibs.length === 0 && oversized.length === 0) {
  console.log("✓ 全部引用的库均已登记，且无超限合约");
  if (seenLibs.size > 0) {
    console.log("");
    console.log("已引用的库：");
    for (const lib of seenLibs) {
      const e = EXPECTED_LIBS.find((x) => x.lib === lib);
      console.log(`  · ${lib}`);
      console.log(`    ${e.reason}`);
    }
    console.log("");
    console.log("⚠️ 部署顺序要求（P8 必须遵守）：");
    console.log(`   1. 先部署以下库合约并记录地址：${[...seenLibs].join("、")}`);
    console.log("   2. 再部署业务合约，构造工厂时传入 { libraries: { <库名>: <addr> } }");
    console.log("   3. 区块浏览器验证业务合约时，一并提供上述库地址");
  }
} else {
  if (unknownLibs.length > 0) {
    console.error(`✗ 存在**未登记**的库链接依赖：${unknownLibs.join("、")}`);
    console.error("   若为业务上不可回避，请在 EXPECTED_LIBS 中登记并说明理由；");
    console.error("   若是误用了 public 版库，请改用 internal 版本以避免部署复杂度。");
  }
  process.exit(1);
}

if (EXEMPTIONS.length > 0) {
  for (const e of EXEMPTIONS) console.log(`  豁免理由 [${e.contract}]: ${e.reason}`);
}
