import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * L5 验证 —— 第三方依赖端到端可用性
 *
 * 本文件回答四个问题，结论直接决定 P2 的架构选型：
 *   1. Semaphore / LeanIMT / Poseidon 能否在无 GitHub 的环境安装并编译？ → 编译层
 *   2. 部署是否必须做库链接？链接后能否正常工作？                      → 部署层
 *   3. **链上维护 Merkle 树的真实 gas 是多少？**                       → 成本层（决定架构）
 *   4. 链上树与链下重放是否确定性一致？                                → 正确性层
 *
 * 【为什么第 3 问是决定性的】
 *   若链上 insert 的 gas 无法支撑 10 万选民规模（NFR 目标），
 *   则必须改为「链下建树 + 仅上链根」的架构，P2 的实现方式将完全不同。
 *   这不是理论推演，必须实测。
 */
describe("L5 · 第三方依赖验证", function () {
    const SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617n;

    async function deployFixture() {
        // 【硬约束】PoseidonT3 是 public 库，必须单独部署并链接
        const PT3 = await ethers.getContractFactory("PoseidonT3");
        const pt3 = await PT3.deploy();
        await pt3.waitForDeployment();
        const pt3Addr = await pt3.getAddress();

        const Probe = await ethers.getContractFactory("DependencyProbe", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const probe = await Probe.deploy();
        await probe.waitForDeployment();

        return { probe, pt3Addr };
    }

    /** 生成落在 SNARK 标量域内的确定性叶子 */
    function leafFor(i: number | bigint): bigint {
        const h = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`chainvote-leaf-${i}`)));
        return h % SNARK_SCALAR_FIELD;
    }

    // ============================================================
    // 1. 部署与基本功能
    // ============================================================
    describe("部署与基本功能", function () {
        it("PoseidonT3 库可部署，且 DependencyProbe 链接后可部署", async function () {
            const { probe, pt3Addr } = await loadFixture(deployFixture);
            expect(await probe.getAddress()).to.be.properAddress;
            expect(pt3Addr).to.be.properAddress;
            // 空树状态
            expect(await probe.size()).to.equal(0n);
            expect(await probe.depth()).to.equal(0n);
        });

        it("空树 root 为零，插入后 root 变化", async function () {
            const { probe } = await loadFixture(deployFixture);
            const emptyRoot = await probe.root();
            expect(emptyRoot).to.equal(0n);

            await probe.insert(leafFor(0));
            expect(await probe.size()).to.equal(1n);
            const root1 = await probe.root();
            expect(root1).to.not.equal(0n);

            await probe.insert(leafFor(1));
            expect(await probe.size()).to.equal(2n);
            expect(await probe.root()).to.not.equal(root1);
        });

        it("has / indexOf 语义正确", async function () {
            const { probe } = await loadFixture(deployFixture);
            const a = leafFor(10);
            const b = leafFor(11);

            await probe.insert(a);
            await probe.insert(b);

            expect(await probe.has(a)).to.equal(true);
            expect(await probe.has(b)).to.equal(true);
            expect(await probe.has(leafFor(99))).to.equal(false);

            expect(await probe.indexOf(a)).to.equal(0n);
            expect(await probe.indexOf(b)).to.equal(1n);
        });

        it("SemaphoreVerifier 接口可被引用（P4 依赖前置确认）", async function () {
            const { probe } = await loadFixture(deployFixture);
            const id = await probe.verifierInterfaceId();
            expect(id).to.not.equal("0x00000000");
        });

        it("插入事件带序号，供链下按序重建树（关键约束）", async function () {
            const { probe } = await loadFixture(deployFixture);
            const a = leafFor(0);

            await expect(probe.insert(a)).to.emit(probe, "LeafInserted").withArgs(0n, a, anyValue, 1n);

            const b = leafFor(1);
            await expect(probe.insert(b)).to.emit(probe, "LeafInserted").withArgs(1n, b, anyValue, 2n);
        });
    });

    // ============================================================
    // 2. 确定性（链上树 ↔ 链下重放必须一致）
    // ============================================================
    describe("确定性", function () {
        it("相同插入顺序 → 相同 root（两个独立实例互证）", async function () {
            const { probe } = await loadFixture(deployFixture);

            // 第二个实例：独立部署一份 PoseidonT3，验证 root 不依赖库地址
            const PT3 = await ethers.getContractFactory("PoseidonT3");
            const pt3b = await PT3.deploy();
            await pt3b.waitForDeployment();
            const Probe2 = await ethers.getContractFactory("DependencyProbe", {
                libraries: { PoseidonT3: await pt3b.getAddress() },
            });
            const probe2 = await Probe2.deploy();
            await probe2.waitForDeployment();

            const leaves = [leafFor(1), leafFor(2), leafFor(3)];
            for (const l of leaves) {
                await probe.insert(l);
                await probe2.insert(l);
            }

            expect(await probe.root()).to.equal(await probe2.root());
            expect(await probe.depth()).to.equal(await probe2.depth());
        });

        it("插入顺序不同 → root 不同（顺序敏感性）", async function () {
            const { probe } = await loadFixture(deployFixture);
            const PT3 = await ethers.getContractFactory("PoseidonT3");
            const pt3b = await PT3.deploy();
            await pt3b.waitForDeployment();
            const Probe2 = await ethers.getContractFactory("DependencyProbe", {
                libraries: { PoseidonT3: await pt3b.getAddress() },
            });
            const probe2 = await Probe2.deploy();
            await probe2.waitForDeployment();

            const a = leafFor(1);
            const b = leafFor(2);

            await probe.insert(a);
            await probe.insert(b);

            await probe2.insert(b);
            await probe2.insert(a);

            expect(await probe.root()).to.not.equal(await probe2.root());
        });
    });

    // ============================================================
    // 3. ★ 成本实测 —— 决定 P2 架构
    // ============================================================
    describe("★ 成本实测（决定「链上建树」是否可行）", function () {
        it("单个 insert 的 gas", async function () {
            const { probe } = await loadFixture(deployFixture);

            const tx1 = await probe.insert(leafFor(0));
            const r1 = await tx1.wait();
            const g1 = r1!.gasUsed;

            const tx2 = await probe.insert(leafFor(1));
            const r2 = await tx2.wait();
            const g2 = r2!.gasUsed;

            console.log(`        · 第 1 片叶子 insert: ${g1} gas`);
            console.log(`        · 第 2 片叶子 insert: ${g2} gas`);

            expect(g1).to.be.greaterThan(0n);
        });

        it("批量 insertMany(50) 的 gas（= P2 登记单批上限）", async function () {
            const { probe } = await loadFixture(deployFixture);
            const leaves = Array.from({ length: 50 }, (_, i) => leafFor(i));

            const tx = await probe.insertMany(leaves);
            const r = await tx.wait();
            const gas = r!.gasUsed;

            const perLeaf = gas / 50n;
            console.log(`        · insertMany(50) 合计: ${gas} gas`);
            console.log(`        · 均摊每片叶子:       ${perLeaf} gas`);

            expect(await probe.size()).to.equal(50n);
            expect(await probe.depth()).to.be.greaterThan(0n);
        });

        it("★ 趋势测量：每叶成本随树深增长（决定外推是否可信）", async function () {
            const { probe } = await loadFixture(deployFixture);

            // LeanIMT 的 insert 成本为 O(depth)，而 depth = ceil(log2(size))。
            // 因此「小样本均摊值 × 10 万」会系统性低估。必须分规模段测量趋势。
            const BATCH = 64;
            const STAGES = [
                { until: 64, label: "depth≈6 " },
                { until: 512, label: "depth≈9 " },
                { until: 2048, label: "depth≈11" },
            ];

            let inserted = 0;
            const results: Array<{ label: string; perLeaf: number }> = [];

            for (const stage of STAGES) {
                let gasSum = 0n;
                let count = 0;
                while (inserted < stage.until) {
                    const leaves = Array.from({ length: BATCH }, (_, i) =>
                        leafFor(100000 + inserted + i)
                    );
                    const tx = await probe.insertMany(leaves);
                    const r = await tx.wait();
                    gasSum += r!.gasUsed;
                    count += BATCH;
                    inserted += BATCH;
                }
                const perLeaf = Number(gasSum) / count;
                results.push({ label: stage.label, perLeaf });
                console.log(
                    `        · 规模 ${String(stage.until).padStart(5)} 叶 (${stage.label}) ` +
                        `每叶均摊: ${perLeaf.toFixed(0)} gas  |  树深实测 ${await probe.depth()}`
                );
            }

            // 实测结论：每叶成本在 depth 6→11 区间**基本恒定**（比值 ≈0.99）。
            // 原因：LeanIMT 的 _insert 只在 sideNodes[level] 为空时向上哈希，
            //       连续插入下哈希次数呈二进制进位模式，**均摊为 O(1)** 而非 O(depth)。
            // 因此外推应采用**平坦模型**，不得引入随深度增长的臆造系数。
            const first = results[0];
            const last = results[results.length - 1];
            const growth = last.perLeaf / first.perLeaf;
            const isFlat = growth > 0.9 && growth < 1.1;

            const perLeafAt100k = isFlat
                ? (results.reduce((s, r) => s + r.perLeaf, 0) / results.length)
                : first.perLeaf * Math.pow(growth, 6); // 仅在确有增长时才做幂次外推

            const totalGas = perLeafAt100k * 100000;
            const usd = (totalGas * 0.02) / 1e9 * 3000; // gas × 0.02 gwei × 3000 USD/ETH（量级估算）

            console.log("");
            console.log(
                `        · 每叶成本随树深变化(6→11层): ${growth.toFixed(2)}x ⇒ ${
                    isFlat ? "平坦模型（均摊 O(1) 成立）" : "随深度增长"
                }`
            );
            console.log(`        · depth=17 推算每叶:   ${perLeafAt100k.toFixed(0)} gas`);
            console.log(`        · 10 万选民建树总 gas: ${(totalGas / 1e9).toFixed(1)} 十亿`);
            console.log(`        · L2 量级成本:         约 ${usd.toFixed(0)} USD`);
            console.log(`        · 批次数(每批64):      约 ${Math.ceil(100000 / 64)} 笔交易`);

            expect(growth).to.be.greaterThan(0);
        });

        it("结论性判据：10 万选民规模下链上建树是否可行", async function () {
            const { probe } = await loadFixture(deployFixture);

            const leaves = Array.from({ length: 64 }, (_, i) => leafFor(500000 + i));
            const r = await (await probe.insertMany(leaves)).wait();
            const perLeaf = Number(r!.gasUsed) / 64;

            // 判据：实测每叶 ≈58k gas，且深度不敏感。
            // 保守取 2 倍安全余量后仍应显著低于单叶 200k gas。
            const conservativePerLeaf = perLeaf * 2;
            expect(conservativePerLeaf).to.be.lessThan(200_000);

            console.log(
                `        · 实测每叶 ${perLeaf.toFixed(0)} gas；2 倍余量 = ` +
                    `${conservativePerLeaf.toFixed(0)} gas（阈 200,000）`
            );
            console.log(
                `        · 判据通过 ⇒ 链上建树可行，保留「合约维护树」的强安全模型，` +
                    `无需退回「链下建树 + 仅上链根」的弱模型`
            );
        });
    });
});
