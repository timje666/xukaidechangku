//  下载 Semaphore snark 产物到 public/snark（在有 egress 的环境运行一次）。
//  本沙箱出口被拦（snark-artifacts.pse.dev 403），故仅供用户机 / CI 使用。
//  下载后前端通过 NEXT_PUBLIC_SNARK_ARTIFACTS_URL（默认 /snark）显式加载，
//  避免运行时自动联网依赖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "public", "snark");
const VERSION = process.env.SNARK_VERSION || "4.13.0";
const BASE = `https://snark-artifacts.pse.dev/semaphore/${VERSION}`;

fs.mkdirSync(OUT, { recursive: true });

let failed = false;
for (const f of ["semaphore.wasm", "semaphore.zkey"]) {
  const url = `${BASE}/${f}`;
  console.log(`downloading ${url}`);
  const code = fs.spawnSync(
    process.platform === "win32" ? "curl.exe" : "curl",
    ["-fL", url, "-o", path.join(OUT, f)],
    { stdio: "inherit" }
  ).status;
  if (code !== 0) {
    console.error(`  失败：${f}（需要可达 egress 的环境）`);
    failed = true;
  }
}

if (failed) {
  console.error("\n部分产物下载失败；真实 ZK 快乐路径需在可达 egress 的环境重新运行本脚本。");
  process.exitCode = 1;
} else {
  console.log(`\n完成：产物已写入 ${OUT}`);
}
