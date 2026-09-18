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
 *
 * 关于「插桩幻影」：
 *   solidity-coverage 对 library 中的 `internal constant` 声明会产生**无对应代码的分支条目**，
 *   且这些条目被映射到**注释行**上。实测 Params.sol 每次编辑后这些行号都会漂移
 *   （曾出现 6#0/11#0，改动后变为 5#0/7#0/12#0）。
 *   ⇒ **按行号硬编码豁免是不可维护的**，会让豁免在每次编辑后失效并产生假失败。
 *   本脚本改为按「该行是否可能包含分支」判定（见 isPhantomLocation），规则不随编辑失效。
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

const sourceCache = new Map();

function sourceLinesFor(file) {
  const posix = toPosix(file);
  if (sourceCache.has(posix)) return sourceCache.get(posix);
  let lines = [];
  try {
    lines = readFileSync(resolve(process.cwd(), file), "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  sourceCache.set(posix, lines);
  return lines;
}

/**
 * 判定某个覆盖率条目是否为「插桩幻影」。
 *
 * 规则严格且可泛化——只有当该行**不可能包含任何控制流**时才豁免：
 *   1. 空行
 *   2. 纯注释行
 *   3. 纯 `constant` 声明行（编译期内联，无分支）
 *
 * 任何含条件、循环、三元、`||`/`&&` 或函数调用的行一律照常报出。
 * 【禁止】在此按行号硬编码豁免——那会在源码编辑后失效，制造假失败。
 */
function isPhantomLocation(file, lineNo) {
  const lines = sourceLinesFor(file);
  const text = (lines[lineNo - 1] ?? "").trim();

  if (text === "") return true;
  if (/^(\/\/|\/\*|\*|\*\/)/.test(text)) return true;
  if (/^(uint|int|bytes|address|bool|string)[0-9]*\s+(internal|public|private)\s+constant\b/.test(text)) {
    return true;
  }
  return false;
}

let totalMisses = 0;
let filesWithGaps = 0;
const phantomStats = new Map();

for (const [file, data] of Object.entries(raw)) {
  // 路径归一化后再判断，避免 Windows 反斜杠导致过滤失效
  const posixFile = toPosix(file);
  if (posixFile.includes("node_modules/") || posixFile.includes("/harness/")) continue;

  const rawLines = Object.entries(data.l ?? {})
    .filter(([, hits]) => Number(hits) === 0)
    .map(([line]) => Number(line))
    .sort((a, b) => a - b);

  const rawBranches = [];
  for (const [line, arr] of Object.entries(data.b ?? {})) {
    arr.forEach((hits, idx) => {
      if (Number(hits) === 0) rawBranches.push({ key: `${line}#${idx}`, line: Number(line) });
    });
  }

  const missLines = rawLines.filter((l) => !isPhantomLocation(file, l));
  const missBranches = rawBranches.filter((b) => !isPhantomLocation(file, b.line));
  const phantom = rawLines.length - missLines.length + (rawBranches.length - missBranches.length);

  if (phantom > 0) phantomStats.set(posixFile, (phantomStats.get(posixFile) ?? 0) + phantom);

  if (missLines.length === 0 && missBranches.length === 0) continue;

  filesWithGaps += 1;
  totalMisses += missLines.length + missBranches.length;

  console.log(`--- ${posixFile}`);
  if (missLines.length) console.log(`    未覆盖行:   ${missLines.join(", ")}`);
  if (missBranches.length) console.log(`    未覆盖分支: ${missBranches.map((b) => b.key).join(", ")}`);
}

if (phantomStats.size > 0) {
  console.log("");
  console.log("已按「行性质」自动豁免的插桩幻影（该行不含任何控制流）：");
  for (const [f, n] of phantomStats) console.log(`    ${f}  (${n} 处)`);
}

console.log("");
if (totalMisses === 0) {
  console.log("✓ 生产合约（不含测试夹具）行与分支全部覆盖（插桩幻影除外，按行性质自动判定）");
} else {
  console.log(`共 ${filesWithGaps} 个文件存在缺口，合计 ${totalMisses} 处`);
  console.log("请逐条判断：补齐测试。若确为工具插桩幻影，需在 isPhantomLocation 中补充");
  console.log("**可泛化**的判定条件（禁止按行号硬编码豁免——那会在源码编辑后失效）。");
  process.exitCode = 1;
}
