import { ethers, network } from "hardhat";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { deployAll, resolveConfigFromEnv, serializeDeployment, type Deployment } from "./deploy-core";

/**
 * P8 部署脚本（CLI 薄壳）。
 *
 * 用法：
 *   npm run deploy:local                       # 本地内存链（进程结束即销毁）
 *   npm run deploy:local -- --network localhost # 本地持久节点（hardhat node）
 *   npx hardhat run script/deploy.ts --network baseSepolia
 *
 * 环境变量（见 .env.example）：
 *   TIMELOCK_MIN_DELAY   操作最小延时（秒），默认 172800（2 天），不得低于合约下限
 *   TIMELOCK_PROPOSER    排程方地址。非本地网络**必填**（应为多签）
 *   TIMELOCK_EXECUTOR    执行方地址；不设则任何人均可执行已到期的操作
 *   TIMELOCK_ADMIN       无延时管理员；不设则自管理（推荐）
 *   ELECTION_ADMIN       获得 CREATOR_ROLE 的地址；不设则跳过排程
 *   FAST_FORWARD         本地链：排程后快进并执行（默认本地 true）
 *   SMOKE                部署后冒烟测试（默认本地 true）
 *   DEPLOY_OUT           产物路径；默认 deployments/<network>.json
 *
 * 【与方案的差异说明】v2 方案写的是 Foundry 的 `forge script`。
 *   因目标环境 GitHub 不可达、Foundry 无法安装（P0 已记录），
 *   本脚本是其在 Hardhat 下的等价实现：同样的部署顺序、同样的
 *   `deployments/*.json` 产物、同样的「二次执行地址一致」验收（见
 *   scripts/check-deploy-determinism.mjs）。差异已记入 P8 交付记录 §2。
 */

function summarize(dep: Deployment, outPath: string): void {
    console.log("");
    console.log("═".repeat(78));
    console.log(`ChainVote 部署完成 · 网络 ${dep.network}（chainId=${dep.chainId}）`);
    console.log("═".repeat(78));
    console.log(`部署者            ${dep.deployer}`);
    console.log(`初始管理员        Timelock 自管理（admin=${dep.timelock.admin}）`);
    console.log(`时间锁最小延时    ${dep.timelock.minDelay}s（${Number(dep.timelock.minDelay) / 86400} 天）`);
    console.log(`排程方            ${dep.timelock.proposer}`);
    console.log("");
    console.log("已部署合约（按部署顺序，地址可由 (deployer, nonce) 复现）");
    for (const [name, c] of Object.entries(dep.contracts)) {
        console.log(
            `  ${name.padEnd(20)} ${c.address}  gas=${c.gasUsed.padStart(9)}  区块 ${c.blockNumber}`
        );
        const libs = Object.entries(c.libraries);
        if (libs.length > 0) {
            console.log(`  ${" ".repeat(20)}  链接：${libs.map(([k, v]) => `${k}=${v}`).join("、")}`);
        }
    }
    console.log("");
    for (const op of dep.timelockOperations) {
        const label = { executed: "✅ 已执行", scheduled: "⏳ 已排程", "not-scheduled": "ℹ️ 未排程" }[
            op.state
        ];
        console.log(`${label}  ${op.signature} → ${op.target}`);
        console.log(`          operationId ${op.operationId}`);
        if (op.note) console.log(`          ${op.note}`);
    }
    if (dep.smoke) {
        console.log("");
        console.log("冒烟测试（端到端）");
        console.log(`  名册      ${dep.smoke.registry}`);
        console.log(`  提案 #${dep.smoke.proposalId}  ${dep.smoke.proposal}`);
        console.log(`  创建者    ${dep.smoke.creator}`);
    }
    console.log("");
    console.log(`部署后自检        ${dep.checks.length} 项全部通过`);
    console.log(`产物              ${relative(process.cwd(), outPath).replace(/\\/g, "/")}`);
    console.log("");
    console.log("下一步");
    console.log("  1) 源码验证：npm run verify:deployment -- --network <net>");
    console.log("  2) 若本次是真实网络：确认时间锁操作在期满后被执行");
    console.log("     npx hardhat run script/execute-operation.ts --network <net>");
    console.log("═".repeat(78));
}

async function main(): Promise<void> {
    const signers = await ethers.getSigners();
    if (signers.length === 0) {
        throw new Error("没有可用签名账户：请在 .env 配置 DEPLOYER_PK，或使用本地网络");
    }
    const deployer = signers[0];
    const chainId = Number((await ethers.provider.getNetwork()).chainId);

    // 本地链：把第二个账户作为默认选举管理员，使「部署者无业务角色」可被真实检验
    const localAdminCandidate = signers[1] ? await signers[1].getAddress() : undefined;

    const cfg = resolveConfigFromEnv(network.name, chainId, await deployer.getAddress(), localAdminCandidate);
    const dep = await deployAll(cfg);

    const outPath = resolve(process.cwd(), process.env.DEPLOY_OUT ?? `deployments/${network.name}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeDeployment(dep) + "\n", "utf8");

    summarize(dep, outPath);
}

main().catch((err) => {
    console.error("");
    console.error("✗ 部署失败");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
