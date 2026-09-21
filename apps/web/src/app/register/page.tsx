"use client";

import { useEffect, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { WalletBar } from "@/components/WalletBar";
import { loadIdentity, createIdentity } from "@/lib/semaphore";
import { publicClient } from "@/lib/clients";
import { ABIS, addressesFor } from "@/chain/contracts.generated";
import { activeChainKey } from "@/chain/config";
import { explainError } from "@/lib/errors";

export default function RegisterPage() {
  const { isConnected, address } = useAccount();
  const { writeContract, data: txHash, isPending, error } = useWriteContract();

  const [commitment, setCommitment] = useState<string>("");
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [registrarVoter, setRegistrarVoter] = useState("");
  const [registrarCommitment, setRegistrarCommitment] = useState("");
  const [banner, setBanner] = useState<{ kind: string; text: string } | null>(null);

  const registry = addressesFor(activeChainKey).VoterRegistry as `0x${string}`;

  //  载入/生成本机身份
  useEffect(() => {
    const stored = loadIdentity();
    if (stored) setCommitment(stored.commitment);
  }, []);

  //  查询本机承诺是否已入册
  useEffect(() => {
    if (!commitment) return;
    let alive = true;
    publicClient()
      .readContract({
        address: registry,
        abi: ABIS.VoterRegistry,
        functionName: "isEnrolled",
        args: [BigInt(commitment)],
      })
      .then((v) => alive && setEnrolled(Boolean(v)))
      .catch(() => alive && setEnrolled(null));
    return () => {
      alive = false;
    };
  }, [commitment, registry]);

  function handleCreate() {
    const stored = createIdentity();
    setCommitment(stored.commitment);
    setEnrolled(false);
  }

  function copyCommitment() {
    navigator.clipboard?.writeText(commitment);
    setBanner({ kind: "ok", text: "承诺已复制到剪贴板，可发给管理员入册。" });
  }

  function handleRegister() {
    if (!registrarVoter || !registrarCommitment) {
      setBanner({ kind: "contract", text: "请填写选民地址与承诺。" });
      return;
    }
    setBanner(null);
    writeContract({
      address: registry,
      abi: ABIS.VoterRegistry,
      functionName: "registerVoters",
      args: [[registrarVoter as `0x${string}`], [BigInt(registrarCommitment)]],
    });
  }

  useEffect(() => {
    if (error) {
      const e = explainError(error, ABIS.VoterRegistry as never);
      setBanner({ kind: e.category, text: `${e.title}：${e.detail}` });
    }
  }, [error]);

  useEffect(() => {
    if (txHash) setBanner({ kind: "ok", text: `入册交易已提交：${txHash.slice(0, 10)}…` });
  }, [txHash]);

  return (
    <main className="page">
      <header className="topbar">
        <h1>① 登记身份</h1>
        <WalletBar />
      </header>

      <section className="panel">
        <h2>选民：生成身份</h2>
        <p className="muted">
          身份 secret 仅存本机（localStorage），绝不离开浏览器，也不经中继发送。
        </p>
        {commitment ? (
          <div className="kv">
            <span>身份承诺</span>
            <code>{commitment}</code>
          </div>
        ) : (
          <button className="btn" onClick={handleCreate}>
            生成身份
          </button>
        )}
        {commitment && (
          <div className="row">
            <button className="btn-ghost" onClick={copyCommitment}>
              复制承诺
            </button>
            <button className="btn-ghost" onClick={handleCreate}>
              重新生成
            </button>
          </div>
        )}
        {commitment && (
          <p className={enrolled ? "tag-ok" : "tag-warn"}>
            {enrolled === null
              ? "入册状态查询中…"
              : enrolled
                ? "✅ 已入册，可前往投票"
                : "⏳ 尚未入册：请把承诺交给管理员（见下方）"}
          </p>
        )}
      </section>

      {isConnected && (
        <section className="panel">
          <h2>管理员：入册选民（需 REGISTRAR_ROLE）</h2>
          <p className="muted">当前连接：{address}</p>
          <label className="field">
            <span>选民地址</span>
            <input
              value={registrarVoter}
              onChange={(e) => setRegistrarVoter(e.target.value)}
              placeholder="0x…"
            />
          </label>
          <label className="field">
            <span>身份承诺</span>
            <input
              value={registrarCommitment}
              onChange={(e) => setRegistrarCommitment(e.target.value)}
              placeholder="uint256"
            />
          </label>
          <button className="btn" disabled={isPending} onClick={handleRegister}>
            {isPending ? "提交中…" : "入册"}
          </button>
        </section>
      )}

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
    </main>
  );
}
