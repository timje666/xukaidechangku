#!/usr/bin/env node
/**
 * 部署确定性检查（P8 门禁）
 *
 * 用法：node scripts/check-deploy-determinism.mjs
 *
 * 验收目标（对应 P8 DoD「anvil 二次执行地址一致」）：
 *   在**两个相互独立的进程**里各跑一次部署脚本，落在同一条全新链上，
 *   两次得到的合约地址必须逐一相同。
 *
 * 为什么必须是「两个进程」而不是同一个进程里跑两次：
 *   进程内的重复调用可能复用缓存/状态，无法暴露「依赖外部随机量」的实现错误。
 *   独立进程 + 全新内存链 = 真实模拟「换台机器、重置链、重新部署」的场景，
 *   这正是 anvil 二次执行的语义。
 *
 * 判定方式：
 *   对比两次产物的**全部字段**，只忽略两处**时间派生**字段：
 *     · `deployedAt`        —— 本机墙钟时间
 *     · `timelockOperations[].eta` —— 链上时间戳（= 排程区块时间 + 延时）
 *   二者按定义不可能相同，且与「地址是否可复现」无关；
 *   其余字段（地址、交易哈希、区块号、gas、构造参数、操作 id）必须逐位一致。
 *   其中「交易哈希一致」是一条很强的旁证：它要求 nonce、calldata、gas 定价
 *   全部一致，任何隐藏的随机输入都会让它失败。
 *
 * 退出码：两次产物不一致时为 1。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 本脚本位于仓库根的 scripts/，既可能被「从仓库根」调用，也可能被
// `npm run check:determinism`（cwd=contracts/）调用。无论哪种情况，
// contracts/ 目录都是「包含 node_modules/hardhat 的那一级」。
const CWD = process.cwd();
const CONTRACTS_DIR_CANDIDATES = [
  CWD,
  resolve(CWD, "contracts"),
];
const CONTRACTS_DIR =
  CONTRACTS_DIR_CANDIDATES.find((d) => existsSync(join(d, "node_modules", "hardhat", "package.json"))) ??
  CWD;
const CLI_CANDIDATES = [
  join(CONTRACTS_DIR, "node_modules", "hardhat", "internal", "cli", "bootstrap.js"),
  join(CONTRACTS_DIR, "node_modules", "hardhat", "internal", "cli", "cli.js"),
];

const cli = CLI_CANDIDATES.find((p) => existsSync(p));
if (!cli) {
  console.error("✗ 未找到 Hardhat CLI，请先在 contracts/ 执行 npm ci");
  process.exit(1);
}

const NETWORK = process.env.DETERMINISM_NETWORK ?? "hardhat";

function runDeploy(tag) {
  const out = join(tmpdir(), `chainvote-deploy-${tag}-${process.pid}.json`);
  const res = spawnSync(
    process.execPath,
    [cli, "run", "script/deploy.ts", "--network", NETWORK],
    {
      cwd: CONTRACTS_DIR,
      env: { ...process.env, DEPLOY_OUT: out, FAST_FORWARD: "true", SMOKE: "true" },
      encoding: "utf8",
    }
  );

  if (res.status !== 0) {
    console.error(`✗ 第 ${tag} 次部署失败（退出码 ${res.status}）`);
    console.error(res.stdout ?? "");
    console.error(res.stderr ?? "");
    process.exit(1);
  }
  if (!existsSync(out)) {
    console.error(`✗ 第 ${tag} 次部署未产出 ${out}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

/** 逐字段找出第一处差异，便于定位（返回 null 表示完全一致） */
function firstDiff(a, b, path = "") {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${path}: 类型不同 ${typeof a} vs ${typeof b}`;
  if (a === null || b === null || typeof a !== "object") {
    return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: 数组/对象形态不同`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k);
    if (d) return d;
  }
  return null;
}

const normalize = (dep) => {
  const clone = JSON.parse(JSON.stringify(dep));
  delete clone.deployedAt; // 墙钟时间，按定义不确定
  for (const op of clone.timelockOperations ?? []) delete op.eta; // 链上时间戳，按定义不确定
  return clone;
};

console.log("部署确定性检查（两个独立进程 · 各自全新链）");
console.log(`  网络        ${NETWORK}`);
console.log(`  Hardhat CLI ${cli.replace(CONTRACTS_DIR, "contracts").replace(/\\/g, "/")}`);

const run1 = normalize(runDeploy("run1"));
const run2 = normalize(runDeploy("run2"));

console.log("");
console.log("第一次部署");
for (const [name, c] of Object.entries(run1.contracts)) {
  console.log(`  ${name.padEnd(20)} ${c.address}`);
}
console.log("第二次部署");
for (const [name, c] of Object.entries(run2.contracts)) {
  console.log(`  ${name.padEnd(20)} ${c.address}`);
}

const diff = firstDiff(run1, run2);
console.log("");
if (diff) {
  console.error(`✗ 两次部署结果不一致（首次差异）：${diff}`);
  console.error("  部署必须只依赖 (deployer, nonce, 固定参数)：请检查是否引入了时间戳、");
  console.error("  随机 salt、外部状态读取等不确定输入。");
  process.exit(1);
}

console.log(`✓ 两次独立进程部署的 ${Object.keys(run1.contracts).length} 个合约地址与全部产物字段完全一致`);
console.log("  说明：部署过程不含任何随机量，满足 P8 DoD「anvil 二次执行地址一致」");
