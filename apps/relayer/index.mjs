//  ChainVote 纯中继服务（apps/relayer）
//
//  职责：接收前端生成的 SemaphoreProof，用本服务的 funded 账户代付 gas 广播
//  Proposal.castVote。前端 / 选民地址不出现在投票交易里（匿名保护）。
//
//  隐私边界（R-P5-1）：
//  - 私钥仅存本服务 .env（RELAYER_PRIVATE_KEY），绝不进前端，绝不提交仓库。
//  - 日志只记录 txHash 与 nullifier（非 PII），不记录来源 IP / 选民身份明文。
//  - 入口处剥离一切可关联来源字段，仅透传证明本身。
//
//  运行：在 apps/relayer 下 `npm install && cp .env.example .env && npm start`
//        （本地默认连 http://127.0.0.1:31337，端口 4100）

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import nodeHttp from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", ".."); // apps/relayer → 仓库根

const RPC = process.env.RELAYER_RPC || "http://127.0.0.1:31337";
const CHAIN_ID = Number(process.env.RELAYER_CHAIN_ID || 31337);
const PORT = Number(process.env.RELAYER_PORT || 4100);
const PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY || "";
const PROPOSAL_OVERRIDE = process.env.PROPOSAL_ADDRESS || "";

if (!PRIVATE_KEY) {
  console.error("[relayer] 缺少 RELAYER_PRIVATE_KEY（仅存服务 .env，切勿进前端）");
  process.exit(1);
}

const chain = {
  id: CHAIN_ID,
  name: "chainvote-local",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });
const publicClient = createPublicClient({ chain, transport: http(RPC) });

//  加载 Proposal ABI（与合约编译产物同步）
const artifactPath = path.resolve(
  ROOT,
  "contracts/artifacts/contracts/proposal/Proposal.sol/Proposal.json"
);
const PROPOSAL_ABI = JSON.parse(fs.readFileSync(artifactPath, "utf8")).abi;

//  默认提案地址：env > deployments/hardhat.json 的 smoke.proposal
function defaultProposal() {
  if (PROPOSAL_OVERRIDE) return PROPOSAL_OVERRIDE;
  try {
    const dep = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, "contracts/deployments/hardhat.json"), "utf8")
    );
    return dep.smoke?.proposal || "";
  } catch {
    return "";
  }
}
const DEFAULT_PROPOSAL = defaultProposal();

const jsonReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

//  从 viem 错误里抽取合约 revert 的原始 data（selector+args），供前端映射中文
function extractRevertData(err) {
  const cause = err?.cause;
  if (cause?.data?.data) return cause.data.data; // raw 0x… revert data
  if (cause?.data?.selector) return cause.data.selector;
  if (err?.data?.data) return err.data.data;
  if (err?.cause?.data?.errorName) return err.cause.data.errorName;
  return undefined;
}

const server = nodeHttp.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/relay") {
    res.writeHead(404).end(JSON.stringify({ ok: false, error: "not found" }));
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400).end(JSON.stringify({ ok: false, error: "invalid json" }));
    return;
  }

  const proposal = parsed.proposal || DEFAULT_PROPOSAL;
  const p = parsed.proof;
  if (!proposal || !p) {
    res.writeHead(400).end(JSON.stringify({ ok: false, error: "missing proposal/proof" }));
    return;
  }

  //  bigint 字段从 JSON 数字/字符串还原
  const proofStruct = {
    merkleTreeDepth: Number(p.merkleTreeDepth),
    merkleTreeRoot: BigInt(p.merkleTreeRoot),
    nullifier: BigInt(p.nullifier),
    message: BigInt(p.message),
    scope: BigInt(p.scope),
    points: p.points.map(BigInt),
  };

  try {
    const txHash = await walletClient.writeContract({
      address: proposal,
      abi: PROPOSAL_ABI,
      functionName: "castVote",
      args: [proofStruct],
    });
    //  仅记录 txHash + nullifier（非 PII）
    console.log(`[relayer] castVote ok tx=${txHash} nullifier=${proofStruct.nullifier}`);
    res.writeHead(200).end(JSON.stringify({ ok: true, txHash }, jsonReplacer));
  } catch (err) {
    const data = extractRevertData(err);
    const msg = err?.shortMessage || err?.message || String(err);
    console.warn(`[relayer] castVote reverted nullifier=${proofStruct.nullifier} data=${data || msg}`);
    res.writeHead(400).end(JSON.stringify({ ok: false, error: msg, data }, jsonReplacer));
  }
});

server.listen(PORT, () => {
  console.log(`[relayer] listening on :${PORT}`);
  console.log(`[relayer] proposal=${DEFAULT_PROPOSAL || "(env PROPOSAL_ADDRESS)"} rpc=${RPC}`);
});
