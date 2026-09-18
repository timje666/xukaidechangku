#!/usr/bin/env node
/**
 * 覆盖率缺口报告
 *
 * 用法：node scripts/report-coverage-gaps.mjs
 * 读取 hardhat coverage 生成的 coverage.json，列出未被覆盖的代码行与分支。
 *
 * 为什么需要它：
 *   覆盖率的「百分比」只能说明有没有缺口，不能说明缺口在哪。
 *   本项目有多条硬约束与安全断言（如 `revert ZeroAddress()`、
 *   popcount 的循环上界分支），这些分支恰恰是最需要被测试触达的部分。
 *   本脚本把缺口定位到具体行号，供人工判断「该补测试」还是「该豁免」。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
const toPosix = (s) => s.split("\\").join("/");

/**
 * 已登记的豁免项。
 *
 * 规则：每一条豁免都必须给出**可验证的技术理由**，不接受"暂时跳过"。
 * 未被登记且命中豁免规则的缺口会照常报出，因此这里不是白名单，而是白名单+理由。
 */
const EXEMPTIONS = [
  {
    file: "contracts/libs/Params.sol",
    branches: ["6#0", "11#0"],
    reason:
      "solidity-coverage 插桩偏差：这两行均为注释（第 6 行为 @notice 正文，第 11 行为分隔线），" +
      "不含任何分支。已通过 P1 对照实验确认：关闭 optimizer 后该现象依然存在，" +
      "故与代码内联无关，属工具对 library 中 `internal constant` 声明的插桩产物。" +
      "注意：本豁免只针对这两处，其他缺口仍会照常报出。",
  },
];

function isExempt(file, key) {
  const posix = toPosix(file);
  return EXEMPTIONS.some(
    (e) => posix.endsWith(e.file) && (e.lines?.includes(key) || e.branches?.includes(key))
  );
}

let totalMisses = 0;
let exempted = 0;
let filesWithGaps = 0;
const exemptedHits = new Map();

for (const [file, data] of Object.entries(raw)) {
  // 路径归一化后再判断，避免 Windows 反斜杠导致过滤失效
  const posixFile = toPosix(file);
  if (posixFile.includes("node_modules/") || posixFile.includes("/harness/")) continue;

  const allLines = Object.entries(data.l ?? {})
    .filter(([, hits]) => Number(hits) === 0)
    .map(([line]) => Number(line))
    .sort((a, b) => a - b);

  const allBranches = [];
  for (const [line, arr] of Object.entries(data.b ?? {})) {
    arr.forEach((hits, idx) => {
      if (Number(hits) === 0) allBranches.push(`${line}#${idx}`);
    });
  }

  const missLines = allLines.filter((l) => !isExempt(file, String(l)));
  const missBranches = allBranches.filter((b) => !isExempt(file, b));
  const suppressed =
    allLines.length - missLines.length + (allBranches.length - missBranches.length);

  if (suppressed > 0) {
    exempted += suppressed;
    exemptedHits.set(toPosix(file), suppressed);
  }

  if (missLines.length === 0 && missBranches.length === 0) continue;

  filesWithGaps += 1;
  totalMisses += missLines.length + missBranches.length;

  console.log(`--- ${toPosix(file)}`);
  if (missLines.length) console.log(`    未覆盖行:   ${missLines.join(", ")}`);
  if (missBranches.length) console.log(`    未覆盖分支: ${missBranches.join(", ")}`);
}

if (exempted > 0) {
  console.log("");
  console.log(`已按登记理由豁免 ${exempted} 处：`);
  for (const [file, n] of exemptedHits) console.log(`    ${file}  (${n} 处)`);
  for (const e of EXEMPTIONS) {
    if (exemptedHits.has(e.file) || [...exemptedHits.keys()].some((k) => k.endsWith(e.file))) {
      console.log(`    理由：${e.reason}`);
    }
  }
}

console.log("");
if (totalMisses === 0) {
  console.log("✓ 生产合约（不含测试夹具）行与分支全部覆盖，或已登记豁免");
} else {
  console.log(`共 ${filesWithGaps} 个文件存在缺口，合计 ${totalMisses} 处`);
  console.log("请逐条判断：补齐测试，或在本脚本的 EXEMPTIONS 中登记豁免并说明技术理由。");
  process.exitCode = 1;
}
