import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializeDeployment, type Deployment } from "./deploy-core";

/**
 * 执行已到期的 Timelock 操作。
 *
 * 背景：生产环境的角色变更不能由部署脚本「一条龙」完成 —— 那正是时间锁要防的事。
 *   `deploy.ts` 只负责**排程**；等待期满后，需要有人（通常是多签或任何被授权的执行方）
 *   再提交一次执行交易。本脚本即为这一步，且它**只做执行**：不新增操作、不改参数，
 *   只在 `isOperationReady` 为真时提交，因此即使被误跑也不会改变治理意图。
 *
 * 用法：
 *   npx hardhat run script/execute-operation.ts --network baseSepolia
 *   npx hardhat run script/execute-operation.ts --network baseSepolia -- --dry-run
 */

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
    const outPath = resolve(process.cwd(), process.env.DEPLOY_OUT ?? `deployments/${network.name}.json`);
    const dep = JSON.parse(readFileSync(outPath, "utf8")) as Deployment;
    const timelockAddr = dep.contracts.Timelock?.address;
    if (!timelockAddr) throw new Error(`${outPath} 中缺少 Timelock 地址`);

    const timelock = await ethers.getContractAt("Timelock", timelockAddr);
    const [signer] = await ethers.getSigners();
    if (!signer) throw new Error("没有可用签名账户");

    let executed = 0;
    const pending = dep.timelockOperations.filter((op) => op.state !== "executed");
    if (pending.length === 0) {
        console.log("没有待执行的时间锁操作 —— 治理状态已与产物一致");
        return;
    }

    for (const op of pending) {
        const call = { target: op.target, value: 0n, data: op.data, predecessor: ethers.ZeroHash, salt: op.salt };
        const onChainId = await timelock.hashOperation(op.target, 0, op.data, ethers.ZeroHash, op.salt);
        const ready: boolean = await timelock.isOperationReady(onChainId);
        const pendingState: boolean = await timelock.isOperationPending(onChainId);
        const done: boolean = await timelock.isOperationDone(onChainId);
        const ts: bigint = await timelock.getTimestamp(onChainId);

        console.log(`操作 ${onChainId}`);
        console.log(`  ${op.signature} → ${op.target}`);
        console.log(
            `  链上状态：done=${done} pending=${pendingState} ready=${ready} 可执行时间=${ts}`
        );

        if (done) {
            op.state = "executed";
            continue;
        }
        if (!ready) {
            const now = BigInt(Math.floor(Date.now() / 1000));
            const remain = ts > now ? Number(ts - now) : 0;
            console.log(`  ⏳ 尚未到执行时间，剩余约 ${(remain / 3600).toFixed(1)} 小时；跳过`);
            continue;
        }
        if (DRY_RUN) {
            console.log("  （--dry-run：仅报告，未提交）");
            continue;
        }

        // 记录执行前的角色状态，执行后复核 —— 避免「交易成功但角色没变」
        const factory = await ethers.getContractAt("ProposalFactory", op.target);
        const before = await factory.hasRole(op.args[0] as string, op.args[1] as string);
        await (await timelock.connect(signer).execute(call.target, call.value, call.data, call.predecessor, call.salt)).wait();
        const after = await factory.hasRole(op.args[0] as string, op.args[1] as string);
        if (before === after) {
            throw new Error(`执行交易已上链，但角色状态未变化（${op.args[1]}）—— 请人工核查`);
        }
        op.state = "executed";
        op.note = `${op.note ?? ""} 由 ${await signer.getAddress()} 于 ${new Date().toISOString()} 执行`.trim();
        executed += 1;
        console.log(`  ✅ 已执行：hasRole ${before} → ${after}`);
    }

    if (executed > 0) {
        writeFileSync(outPath, serializeDeployment(dep) + "\n", "utf8");
        console.log("");
        console.log(`已执行 ${executed} 个操作，产物已更新：${outPath}`);
    }
}

main().catch((err) => {
    console.error("");
    console.error("✗ 执行时间锁操作失败");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
