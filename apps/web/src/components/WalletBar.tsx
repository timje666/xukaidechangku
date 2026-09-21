"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

/**
 * 钱包连接条：支持 ≥ 2 种钱包（注入式 / Coinbase Wallet），满足 P9 DoD。
 * 仅做连接与展示；投票提交走中继，不依赖钱包签名（匿名保护）。
 */
export function WalletBar() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const label = (id: string, name?: string) => {
    if (id === "injected") return "MetaMask / 注入钱包";
    if (id === "coinbaseWallet") return "Coinbase Wallet";
    if (id === "walletConnect") return "WalletConnect";
    return name || id;
  };

  if (isConnected && address) {
    return (
      <div className="wallet">
        <span className="wallet-addr" title={address}>
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>
        <span className="wallet-chain">{chain?.name ?? "未知网络"}</span>
        <button className="btn-ghost" onClick={() => disconnect()}>
          断开
        </button>
      </div>
    );
  }

  return (
    <div className="wallet">
      {connectors.map((c) => (
        <button
          key={c.uid}
          className="btn"
          disabled={isPending}
          onClick={() => connect({ connector: c })}
        >
          连接 {label(c.id, c.name)}
        </button>
      ))}
    </div>
  );
}
