import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

/**
 * ChainVote - Hardhat 配置
 *
 * 工具链说明（P0 决策，详见 docs/P0-环境搭建记录.md）：
 *   原方案指定 Foundry（forge/cast/anvil），但本机 GitHub 不可达，
 *   Foundry 分发包与其 forge install 依赖 GitHub，无法安装。
 *   故 P0 采用 Hardhat 2.x + ethers v6 + mocha/chai 作为等价替代。
 */

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "";
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "";
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "";
const DEPLOYER_PK = process.env.DEPLOYER_PK ?? "";

const accounts = DEPLOYER_PK ? [DEPLOYER_PK] : [];

/**
 * 覆盖率模式会关闭 optimizer。
 *
 * 原因（P1 对照实验结论）：
 *   optimizer 会把 library 的 `internal` 函数内联进调用方，导致 solidity-coverage
 *   的行覆盖归属发生偏移——已被测试实际执行的代码被报为「未覆盖」。
 *   实测：同一份代码，optimizer 开启时 Params/BallotCodec 出现 3 处虚假缺口，
 *   关闭后完全消失。若不关闭，覆盖率门禁会产生**假阴性**，
 *   使团队花费时间追查不存在的缺口，或反向掩盖真实缺口。
 *
 * 注意：本开关只影响覆盖率采集。gas 测量（REPORT_GAS）与生产部署仍使用
 *       optimizer enabled / runs=200 的生产配置。
 */
const COVERAGE_MODE = process.env.COVERAGE_MODE === "true";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: !COVERAGE_MODE, runs: 200 },
      evmVersion: "paris",
      viaIR: false,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL,
      chainId: 84532,
      accounts,
    },
    base: {
      url: BASE_RPC_URL,
      chainId: 8453,
      accounts,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  etherscan: {
    apiKey: {
      baseSepolia: process.env.BASESCAN_API_KEY ?? "",
      base: process.env.BASESCAN_API_KEY ?? "",
    },
  },
  mocha: {
    timeout: 120000,
  },
};

export default config;
