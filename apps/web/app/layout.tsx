import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ChainVote · 去中心化投票系统",
  description: "基于公开链与零知识凭证的匿名投票系统",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          background: "#ffffff",
          color: "#2C2C2A",
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
