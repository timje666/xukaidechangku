/**
 * P0 阶段页面 —— 仅用于验证前端工具链可用。
 * 正式 UI（登记 / 投票 / 揭示 / 结果公示）在 P9、P10 实现。
 */

const FROZEN_PARAMS: Array<{ label: string; value: string; source: string }> = [
  { label: "选项数上限", value: "16", source: "位图位宽" },
  { label: "每人最多可选", value: "8", source: "冻结 Q6" },
  { label: "揭示窗口", value: "48 小时", source: "冻结 Q3" },
  { label: "登记单批上限", value: "50 地址", source: "F-09 修正" },
  { label: "Relayer 免费额度", value: "20 次 / 提案 / 地址", source: "冻结 Q5" },
];

const HARD_RULES = [
  "不存在任何管理员干预票期的接口（无暂停、无提前结束、无延时开放）",
  "投票期链上只存承诺值，票数在密码学意义上不可读",
  "揭示时必须校验承诺曾于投票期上链，否则可凭空造票",
  "链上不存任何可识别个人身份的信息；名册明文仅存链下受控库",
  "投票权凭证不具金融属性，不发行可转让代币",
];

export default function Home() {
  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "56px 24px 80px" }}>
      <p
        style={{
          display: "inline-block",
          margin: 0,
          padding: "2px 10px",
          border: "0.5px solid #B5D4F4",
          borderRadius: 8,
          background: "#E6F1FB",
          color: "#0C447C",
          fontSize: 13,
        }}
      >
        P0 · 环境搭建与参数冻结
      </p>

      <h1 style={{ fontSize: 28, fontWeight: 500, margin: "18px 0 8px" }}>
        基于区块链的去中心化投票系统
      </h1>
      <p style={{ margin: 0, color: "#5F5E5A", fontSize: 15 }}>
        本页面当前仅用于验证前端工具链可用。登记、投票、揭示与结果公示界面将在 P9、P10 阶段实现。
      </p>

      <h2 style={{ fontSize: 17, fontWeight: 500, margin: "40px 0 12px" }}>已冻结参数</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#5F5E5A" }}>
            <th style={th}>参数</th>
            <th style={th}>取值</th>
            <th style={th}>依据</th>
          </tr>
        </thead>
        <tbody>
          {FROZEN_PARAMS.map((p) => (
            <tr key={p.label}>
              <td style={td}>{p.label}</td>
              <td style={{ ...td, fontWeight: 500 }}>{p.value}</td>
              <td style={{ ...td, color: "#5F5E5A" }}>{p.source}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: 17, fontWeight: 500, margin: "40px 0 12px" }}>不可裁剪的硬约束</h2>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
        {HARD_RULES.map((r) => (
          <li key={r} style={{ marginBottom: 6 }}>
            {r}
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 44, fontSize: 13, color: "#888780" }}>
        合约源码：contracts/ · 参数真相源：contracts/contracts/libs/Params.sol
      </p>
    </main>
  );
}

const th: React.CSSProperties = {
  padding: "8px 12px 8px 0",
  borderBottom: "0.5px solid #D3D1C7",
  fontWeight: 400,
};

const td: React.CSSProperties = {
  padding: "9px 12px 9px 0",
  borderBottom: "0.5px solid #F1EFE8",
};
