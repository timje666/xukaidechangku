"use client";

import { useCallback, useEffect, useState } from "react";
import { toHex, type PublicClient } from "viem";
import { WalletBar } from "@/components/WalletBar";
import { loadIdentity, generateVoteProof } from "@/lib/semaphore";
import { publicClient } from "@/lib/clients";
import { fetchMembership } from "@/lib/membership";
import { readProposalConfig, readPhase, type ProposalConfig } from "@/lib/proposal";
import { ballotCommitment, randomSalt } from "@/lib/scope";
import { encodeBallot, popcount } from "@/lib/ballot";
import { submitViaRelayer } from "@/lib/relayer";
import { explainError } from "@/lib/errors";
import { ABIS, addressesFor } from "@/chain/contracts.generated";
import { activeChainKey } from "@/chain/config";

/**
 * 提交成功后轮询：确认本承诺已上链（isCommitmentCast）。
 * 提升为模块级，避免在 handleVote 的 useCallback 依赖里反复重建。
 */
function pollCommitted(
  client: PublicClient,
  proposal: `0x${string}`,
  commitment: bigint,
  onCommitted: (v: boolean) => void
) {
  let tries = 0;
  const tick = async () => {
    tries += 1;
    try {
      const ok = (await client.readContract({
        address: proposal,
        abi: ABIS.Proposal,
        functionName: "isCommitmentCast",
        //  ballotCommitment 是 bytes32，必须以 0x 十六进制串传入（而非 bigint）。
        args: [toHex(commitment, { size: 32 })],
      })) as boolean;
      if (ok) {
        onCommitted(true);
        return;
      }
    } catch {
      /* ignore */
    }
    if (tries < 10) setTimeout(tick, 1500);
  };
  setTimeout(tick, 1200);
}

function pollParticipation(
  client: PublicClient,
  proposal: `0x${string}`,
  onResult: (n: number) => void
) {
  client
    .readContract({ address: proposal, abi: ABIS.Proposal, functionName: "nullifierCount" })
    .then((v) => onResult(Number(v)))
    .catch(() => {});
}

type VoteState = "idle" | "generating" | "submitting" | "confirmed" | "failed";

export default function VotePage() {
  const [cfg, setCfg] = useState<ProposalConfig | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [picks, setPicks] = useState<boolean[]>([]);
  const [state, setState] = useState<VoteState>("idle");
  const [banner, setBanner] = useState<{ kind: string; text: string } | null>(null);
  const [txHash, setTxHash] = useState<string>("");
  const [committed, setCommitted] = useState<boolean | null>(null);
  const [participation, setParticipation] = useState<number | null>(null);

  const proposal = addressesFor(activeChainKey).Proposal as `0x${string}`;
  const registry = addressesFor(activeChainKey).VoterRegistry as `0x${string}`;

  //  载入提案配置 + 阶段
  useEffect(() => {
    let alive = true;
    const client = publicClient();
    readProposalConfig(proposal, client)
      .then((c) => alive && (setCfg(c), setPicks(Array(c.optionCount).fill(false))))
      .catch(() => alive && setBanner({ kind: "network", text: "无法读取提案配置，请确认本地链已启动。" }));
    readPhase(proposal, client).then((p) => alive && setPhase(p)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [proposal]);

  const toggle = (i: number) => {
    if (!cfg) return;
    setPicks((prev) => {
      const next = [...prev];
      next[i] = !next[i];
      //  超额选择：仅允许切换到更少的选中数；超限时忽略新增
      if (next[i] && popcount(encodeBallot(next)) > cfg.maxChoices) {
        next[i] = false;
      }
      return next;
    });
  };

  const selectedCount = popcount(encodeBallot(picks));

  const handleVote = useCallback(async () => {
    setBanner(null);
    setCommitted(null);

    const stored = loadIdentity();
    if (!stored) {
      setBanner({ kind: "contract", text: "尚未生成身份，请先到「登记」页创建身份。" });
      return;
    }
    if (!cfg) {
      setBanner({ kind: "network", text: "提案配置未加载，请确认本地链已启动。" });
      return;
    }
    if (selectedCount === 0) {
      setBanner({ kind: "contract", text: "请至少选择一项。" });
      return;
    }

    setState("generating");
    try {
      const client = publicClient();

      //  阶段校验（前端预检，合约仍会最终校验）
      const ph = await readPhase(proposal, client);
      setPhase(ph);
      if (ph !== "VOTING") {
        setState("idle");
        setBanner({
          kind: "contract",
          text: ph === "REVEAL" || ph === "CLOSED" || ph === "FINALIZED" ? "投票已结束。" : "投票尚未开放。",
        });
        return;
      }

      //  名册（冻结根 + 成员）
      const membership = await fetchMembership(registry, client);
      if (membership.commitments.length === 0) {
        setState("idle");
        setBanner({ kind: "contract", text: "名册为空或未冻结，暂无法生成证明。" });
        return;
      }

      const salt = randomSalt();
      const mask = encodeBallot(picks);
      const commitment = ballotCommitment(mask, salt, cfg.scope);

      //  离线生成 ZK 证明（或 Mock 证明，由 NEXT_PUBLIC_USE_MOCK_PROOF 控制）
      const proof = await generateVoteProof(stored, membership, cfg.scope, commitment);

      //  经中继提交（代付 gas，匿名）
      setState("submitting");
      const res = await submitViaRelayer(proposal, proof);

      if (res.ok && res.txHash) {
        setTxHash(res.txHash);
        setState("confirmed");
        //  DoD：成功后 5s 内反映最新状态——轮询 isCommitmentCast
        pollCommitted(client, proposal, commitment, setCommitted);
        pollParticipation(client, proposal, setParticipation);
      } else {
        //  中继命中合约回滚：用 Proposal ABI 解码错误名 → 中文
        const e = explainError(
          { data: res.contractErrorData },
          ABIS.Proposal
        );
        setState("failed");
        setBanner({
          kind: e.category,
          text: res.message ? `${e.title}：${res.message}` : `${e.title}：${e.detail}`,
        });
      }
    } catch (err) {
      //  4 类异常：拒绝签名 / gas / 链 / 网络 —— 统一映射
      const e = explainError(err, ABIS.Proposal);
      setState("failed");
      setBanner({ kind: e.category, text: `${e.title}：${e.detail}` });
    }
  }, [cfg, picks, proposal, registry, selectedCount]);

  //  轮询助手见文件底部模块级定义（pollCommitted / pollParticipation）。

  const stateLabel: Record<VoteState, string> = {
    idle: "就绪",
    generating: "生成 ZK 证明中…",
    submitting: "经中继提交中…",
    confirmed: "✅ 已提交",
    failed: "❌ 失败",
  };

  return (
    <main className="page">
      <header className="topbar">
        <h1>② 投票</h1>
        <WalletBar />
      </header>

      <section className="panel">
        <div className={`status ${state}`}>{stateLabel[state]}</div>
        {phase && <p className="muted">当前阶段：{phase}</p>}

        <h2>选择选项（最多 {cfg?.maxChoices ?? "?"} 项）</h2>
        <div className="options">
          {cfg &&
            Array.from({ length: cfg.optionCount }).map((_, i) => (
              <button
                key={i}
                className={`opt ${picks[i] ? "on" : ""}`}
                onClick={() => toggle(i)}
                disabled={state === "generating" || state === "submitting"}
              >
                选项 {i + 1}
              </button>
            ))}
        </div>
        <p className="muted">已选 {selectedCount} 项</p>

        <button
          className="btn"
          onClick={handleVote}
          disabled={state === "generating" || state === "submitting"}
        >
          {state === "generating"
            ? "生成证明…"
            : state === "submitting"
              ? "提交中…"
              : "生成证明并提交"}
        </button>
      </section>

      {state === "confirmed" && (
        <section className="panel">
          <p className="tag-ok">✅ 投票已提交（tx {txHash.slice(0, 10)}…）</p>
          <p className={committed ? "tag-ok" : "tag-warn"}>
            {committed === null
              ? "正在确认选票上链…"
              : committed
                ? "✅ 你的选票承诺已上链（匿名计入）"
                : "暂未确认，请稍候"}
          </p>
          {participation !== null && <p className="muted">当前参与人数：{participation}</p>}
          <p className="muted">
            各选项得票在揭示期结束后封存（getCounts 在封存前故意 revert，UI 显示「计票中」）。
          </p>
        </section>
      )}

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
    </main>
  );
}
