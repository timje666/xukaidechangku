"use client";

import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { injected, coinbaseWallet, walletConnect } from "wagmi/connectors";
import { chains, activeChain } from "./config";

/**
 * wagmi 配置：自研轻量连接 UI，满足 P9 DoD「≥ 2 种钱包」。
 *
 * - injected：MetaMask / Rabby / Brave 等注入式 EIP-1193 钱包（第一类）。
 * - coinbaseWallet：Coinbase Wallet（含 Smart Wallet），无需注册任何第三方账号，
 *   即提供「第二类钱包」，满足 DoD。
 * - WalletConnect：仅当设置了 NEXT_PUBLIC_WC_PROJECT_ID 时启用（可选），
 *   否则移动端走 coinbaseWallet / 注入式，不阻塞构建。
 *
 * 不引入 RainbowKit 以控制依赖与离线可控性（实现文档 §2.4 原选型为 RainbowKit，
 * 此处按「推荐默认」换成原生多连接器，行为等价、依赖更轻）。
 */
//  显式标注为 CreateConnectorFn[]，避免各连接器泛型实例化（storage key 不同）
//  导致的元组类型方差不兼容（injected 用 disconnected/injected.connected，
// walletConnect 用 requestedChains）。
const connectors: CreateConnectorFn[] = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({
    appName: "ChainVote",
    preference: "all", // 同时支持 Coinbase Wallet 扩展与 Smart Wallet
  }),
];

//  WalletConnect 为可选连接器：仅当设置了 NEXT_PUBLIC_WC_PROJECT_ID 时启用。
//  （静态导入；若无需移动端 WC，去掉此处即可避免其进入打包图。）
if (process.env.NEXT_PUBLIC_WC_PROJECT_ID) {
  connectors.push(
    walletConnect({ projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID, showQrModal: true })
  );
}

export const wagmiConfig = createConfig({
  chains,
  connectors,
  ssr: true,
  //  显式 transports map（按 chain id 路由），避免 createConfig 对 client()
  //  返回类型（Client vs HttpTransport）的严格约束冲突。
  transports: {
    [chains[0].id]: http(chains[0].rpcUrls.default.http[0]),
    [chains[1].id]: http(chains[1].rpcUrls.default.http[0]),
  },
});

// 当前激活链（与 config.ts 的 activeChain 一致）
export const defaultChain = activeChain;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
