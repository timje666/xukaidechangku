import { type Chain, hardhat, baseSepolia } from "viem/chains";

/**
 * 链配置。
 *
 * - dev：本地 `npx hardhat node`（端口 31337，默认 chainId 31337）。
 *   P0 决策用 Hardhat 替代 Foundry（anvil 不可用），故本地链走 hardhat node 而非 anvil。
 * - prod：Base Sepolia 测试网（实现文档 D7 / v2 Q11 冻结 Base）。
 *
 * 注意：`hardhat` 这条链在 viem 里默认 rpcUrl 为 http://127.0.0.1:8545，
 * 与 hardhat node 默认端口不同（hardhat node 默认 8545）；本项目本地链用 31337，
 * 故下方覆盖 rpcUrls。
 */
export const LOCAL_CHAIN_ID = 31337;

export const hardhatLocal: Chain = {
  ...hardhat,
  id: LOCAL_CHAIN_ID,
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC || "http://127.0.0.1:31337"] },
  },
};

export const chains: [Chain, Chain] = [hardhatLocal, baseSepolia];

export type AppChainKey = "local" | "baseSepolia";

export function chainKeyFromId(chainId: number): AppChainKey {
  if (chainId === LOCAL_CHAIN_ID) return "local";
  if (chainId === baseSepolia.id) return "baseSepolia";
  return "baseSepolia";
}

/** 当前激活环境：dev 默认 local，生产由 NEXT_PUBLIC_CHAIN 决定。 */
export const activeChainKey: AppChainKey =
  process.env.NEXT_PUBLIC_CHAIN === "baseSepolia" ? "baseSepolia" : "local";

export const activeChain: Chain =
  activeChainKey === "local" ? hardhatLocal : baseSepolia;
