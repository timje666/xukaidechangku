import { network, run } from "hardhat";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ContractEntry, Deployment } from "./deploy-core";

/**
 * 提交区块浏览器源码验证（P8 DoD「浏览器可验证」的落地部分）。
 *
 * 为什么单独一个脚本：验证必须**在真实网络上**执行，且需要 BASESCAN_API_KEY，
 *   而本机无外网、无密钥。把「可验证」做成一条可重复执行的命令 + 一份含全部
 *   构造参数与库地址的产物，使该 DoD 在具备网络与密钥的环境里一条命令即可完成，
 *   而不是留一段「照文档手工填表」的说明。
 *
 * 关键点：含库链接的合约（工厂）必须一并提供库地址，否则验证必然失败；
 *   构造参数也必须逐位一致（Timelock 的参数含数组与 uint256）。
 *   二者都已由 deploy.ts 写进 deployments/<network>.json，本脚本直接复用，
 *   杜绝手工抄错。
 *
 * 用法：
 *   npm run verify:deployment -- --network baseSepolia
 *   npx hardhat run script/verify-deployment.ts --network base -- --dry-run
 */

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
    const outPath = resolve(process.cwd(), process.env.DEPLOY_OUT ?? `deployments/${network.name}.json`);
    if (!existsSync(outPath)) {
        throw new Error(`未找到部署产物 ${outPath}，请先执行 npm run deploy:<network>`);
    }
    const dep = JSON.parse(readFileSync(outPath, "utf8")) as Deployment;

    if (dep.chainId === network.config.chainId) {
        console.log(`产物链 ID 与当前网络一致（${dep.chainId}）`);
    } else {
        throw new Error(
            `产物链 ID ${dep.chainId} 与当前网络 ${network.name}（${network.config.chainId}）不一致，` +
                "拒绝验证以免把 A 链地址提交到 B 链浏览器"
        );
    }
    if (dep.chainId === 31337 || dep.chainId === 1337) {
        console.log("本地链没有区块浏览器，无需验证。");
        return;
    }

    let ok = 0;
    const failed: string[] = [];
    for (const [name, entry] of Object.entries(dep.contracts)) {
        const args = (entry as ContractEntry).constructorArgs ?? [];
        const libs = Object.fromEntries(
            Object.entries((entry as ContractEntry).libraries ?? {}).map(([k, v]) => [k, String(v)])
        );
        console.log("");
        console.log(`→ ${name}  ${entry.address}`);
        console.log(`  构造参数 ${JSON.stringify(args)}`);
        if (Object.keys(libs).length > 0) console.log(`  库地址   ${JSON.stringify(libs)}`);

        if (DRY_RUN) continue;

        try {
            await run("verify:verify", {
                address: entry.address,
                constructorArguments: args,
                libraries: libs,
            });
            ok += 1;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // 已验证过的合约重复提交会报 Already Verified —— 不是失败
            if (/already verified/i.test(msg)) {
                console.log("  已处于已验证状态，跳过");
                ok += 1;
            } else {
                console.error(`  ✗ 验证失败：${msg}`);
                failed.push(name);
            }
        }
    }

    console.log("");
    if (DRY_RUN) {
        console.log("（--dry-run：仅列出待验证清单，未提交）");
        return;
    }
    if (failed.length > 0) throw new Error(`以下合约验证失败：${failed.join("、")}`);
    console.log(`✓ 全部 ${ok} 个合约已在区块浏览器完成源码验证`);
}

main().catch((err) => {
    console.error("");
    console.error("✗ 源码验证失败");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
