import Link from "next/link";
import { WalletBar } from "@/components/WalletBar";

export default function HomePage() {
  return (
    <main className="page">
      <header className="topbar">
        <h1>ChainVote · 去中心化匿名投票</h1>
        <WalletBar />
      </header>

      <section className="hero">
        <h2>端到端匿名投票</h2>
        <p>
          身份承诺留本机、证明离线生成、经中继代付 gas 上链——已登记地址永不出现在投票交易里。
        </p>
        <div className="cards">
          <Link className="card" href="/register">
            <h3>① 登记身份</h3>
            <p>生成 Semaphore 身份（仅存本机），获取承诺并提交给管理员入册。</p>
          </Link>
          <Link className="card" href="/vote">
            <h3>② 投票</h3>
            <p>选好选项 → 离线生成 ZK 证明 → 经中继提交。全程匿名。</p>
          </Link>
        </div>
      </section>

      <footer className="foot">
        本地环境：Hardhat Node (chainId 31337)。生产：Base Sepolia。
      </footer>
    </main>
  );
}
