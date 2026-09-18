/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 前端与合约地址表的对应关系由 packages/config 统一维护（P9 接入）
  env: {
    NEXT_PUBLIC_APP_STAGE: process.env.NEXT_PUBLIC_APP_STAGE ?? "p0",
  },
};

export default nextConfig;
