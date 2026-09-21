/**
 * 从合约编译产物中抽取 ABI 与部署地址，生成前端可直接 import 的 TS 文件。
 *
 * 运行：`node scripts/gen-abis.mjs`（在 apps/web 下，合约需已 `npm run build`）。
 * 产物：`src/chain/contracts.generated.ts`（提交进版本库，CI/build 无需再编译合约）。
 *
 * 设计：前端不应直接依赖 contracts/artifacts（它是 gitignored 的构建产物）。
 * 这里把「读 artifact → 生成 TS」作为一次性同步步骤，生成的文件随仓库走。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", ".."); // apps/web -> repo root
const CONTRACTS = resolve(ROOT, "contracts");

function readAbi(relPath) {
  const p = resolve(CONTRACTS, relPath);
  if (!existsSync(p)) {
    throw new Error(`缺少 artifact：${relPath}\n请先在 contracts/ 执行 npm run build`);
  }
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

function readDeployment() {
  const p = resolve(CONTRACTS, "deployments", "hardhat.json");
  if (!existsSync(p)) {
    throw new Error(`缺少部署产物 contracts/deployments/hardhat.json`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

const proposalAbi = readAbi("artifacts/contracts/proposal/Proposal.sol/Proposal.json");
const registryAbi = readAbi("artifacts/contracts/registry/VoterRegistry.sol/VoterRegistry.json");
const verifierAbi = readAbi(
  "artifacts/@semaphore-protocol/contracts/base/SemaphoreVerifier.sol/SemaphoreVerifier.json"
);

const dep = readDeployment();
const localProposal = dep.smoke?.proposal || dep.contracts?.Proposal?.address || "";
const localRegistry = dep.smoke?.registry || dep.contracts?.VoterRegistry?.address || "";
const localVerifier = dep.contracts?.SemaphoreVerifier?.address || "";

const out = `// 本文件由 scripts/gen-abis.mjs 自动生成，请勿手改。
// 重新生成：在 apps/web 下执行 \`node scripts/gen-abis.mjs\`（需 contracts 已 build）。
/* eslint-disable */

export const ABIS = {
  Proposal: ${JSON.stringify(proposalAbi, null, 2)} as const,
  VoterRegistry: ${JSON.stringify(registryAbi, null, 2)} as const,
  SemaphoreVerifier: ${JSON.stringify(verifierAbi, null, 2)} as const,
};

// 仅 local 链有确定地址（来自 deployments/hardhat.json）；baseSepolia 由部署后写入。
// 生产环境地址通过 NEXT_PUBLIC_PROPOSAL_ADDRESS / NEXT_PUBLIC_REGISTRY_ADDRESS 覆盖。
export const ADDRESSES = {
  local: {
    Proposal: ${JSON.stringify(localProposal)},
    VoterRegistry: ${JSON.stringify(localRegistry)},
    SemaphoreVerifier: ${JSON.stringify(localVerifier)},
  },
  baseSepolia: {
    Proposal: process.env.NEXT_PUBLIC_PROPOSAL_ADDRESS || "",
    VoterRegistry: process.env.NEXT_PUBLIC_REGISTRY_ADDRESS || "",
    SemaphoreVerifier: process.env.NEXT_PUBLIC_VERIFIER_ADDRESS || "",
  },
} as const;

export type AppChainKey = "local" | "baseSepolia";
export function addressesFor(chain: AppChainKey) {
  return ADDRESSES[chain];
}
`;

const target = resolve(__dirname, "..", "src", "chain", "contracts.generated.ts");
writeFileSync(target, out, "utf8");
console.log(`✓ 生成 ${target}`);
console.log(`  local Proposal = ${localProposal || "(空)"}`);
