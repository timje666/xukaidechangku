import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

import { buildProposalInit, buildTimeWindows, commitmentFor } from "./helpers/proposal";

/**
 * P5 单元测试 —— 匿名准入与中继模型
 *
 * 【本阶段最重要的结论】
 * 初版方案选择 `MinimalForwarder` + ERC-2771 来实现「中继代付 gas」，前提是
 * 「Relayer 是全匿名的必要条件」。该前提**方向正确但机制错误**，本文件用实测证伪。
 *
 * 测试分组与各自的作用：
 *
 *   1. 身份泄露判定 —— **证据**。证明 ERC-2771 必然把签名者地址写入交易 calldata，
 *      因此与「隐身份」目标不相容。该组是本节结论的依据，不可删除。
 *
 *   2. 匿名准入强制 —— **正确方案的合约层保证**。已登记地址被禁止直接提交，
 *      而中继账户与一次性地址均可提交。这是合约层唯一能阻断「地址↔选票」关联的位置。
 *
 *   3. 纯中继下的重放防护 —— F-10 在无签名模型下的等价物。纯中继没有 EIP-712 签名，
 *      重放防护由 `nullifier` 唯一性与 `scope` 绑定提供，比 nonce 机制更根本。
 *
 *   4. ERC-2771 参照组 —— **保留知识，避免误判**。验证其重放防护本身是完整的，
 *      从而明确「不用它」的原因是机制与隐私目标冲突，而非质量问题。
 */
describe("P5 · 匿名准入与中继模型", function () {
    const FORWARD_REQUEST_TYPES = {
        ForwardRequest: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "gas", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint48" },
            { name: "data", type: "bytes" },
        ],
    };

    async function deployFixture() {
        const [admin, registrar, relayer, outsider] = await ethers.getSigners();

        const pt3 = await (await ethers.getContractFactory("PoseidonT3")).deploy();
        await pt3.waitForDeployment();
        const pt4 = await (await ethers.getContractFactory("PoseidonT4")).deploy();
        await pt4.waitForDeployment();
        const pt3Addr = await pt3.getAddress();
        const pt4Addr = await pt4.getAddress();

        const mockVerifier = await (await ethers.getContractFactory("MockVerifier")).deploy();
        await mockVerifier.waitForDeployment();

        const R = await ethers.getContractFactory("VoterRegistry", {
            libraries: { PoseidonT3: pt3Addr },
        });
        const now = BigInt(await time.latest());
        const tw = buildTimeWindows(now);

        const registry = await R.deploy(admin.address, tw.registrationEnd);
        await registry.waitForDeployment();

        const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ChainVote.REGISTRAR_ROLE"));
        await registry.connect(admin).grantRole(REGISTRAR_ROLE, registrar.address);

        const P = await ethers.getContractFactory("ProposalHarness", {
            libraries: { PoseidonT4: pt4Addr },
        });
        const proposal = await P.deploy(
            admin.address,
            buildProposalInit({
                proposalId: 1n,
                registry: await registry.getAddress(),
                verifier: await mockVerifier.getAddress(),
                ...tw,
            })
        );
        await proposal.waitForDeployment();

        // 第二个提案：用于验证 scope 绑定（跨提案重放）
        const proposal2 = await P.deploy(
            admin.address,
            buildProposalInit({
                proposalId: 2n,
                registry: await registry.getAddress(),
                verifier: await mockVerifier.getAddress(),
                ...tw,
            })
        );
        await proposal2.waitForDeployment();

        // 登记两个选民地址：outsider 用于「直投被拒」，另一随机地址用于填充名册
        const enrolledVoter = ethers.Wallet.createRandom();
        await registry
            .connect(registrar)
            .registerVoters(
                [outsider.address, enrolledVoter.address],
                [commitmentFor("p5-a"), commitmentFor("p5-b")]
            );
        await time.increaseTo(tw.registrationEnd);
        await registry.freezeVotersRoot();

        const frozenRoot = await registry.frozenRoot();

        return {
            registry,
            mockVerifier,
            proposal,
            proposal2,
            frozenRoot,
            enrolledVoter,
            admin,
            registrar,
            relayer,
            outsider,
            now,
            ...tw,
        };
    }

    type Fixture = Awaited<ReturnType<typeof deployFixture>>;

    /** 构造一个结构完整、可通过替身校验的证明 */
    function makeProof(
        f: Fixture,
        o: {
            nullifier?: bigint;
            message?: bigint;
            scope?: bigint;
            merkleTreeRoot?: bigint;
            proposalScope?: bigint;
        } = {}
    ) {
        return {
            merkleTreeDepth: 20n,
            merkleTreeRoot: o.merkleTreeRoot ?? f.frozenRoot,
            nullifier: o.nullifier ?? 1n,
            message: o.message ?? commitmentFor("p5-ballot"),
            scope: o.proposalScope ?? o.scope ?? 0n,
            points: Array.from({ length: 8 }, (_, i) => BigInt(i + 1)),
        };
    }

    /** 构造某提案的 castVote calldata（scope 已填对） */
    async function castVoteData(
        f: Fixture,
        proposal: (typeof f)["proposal"],
        nullifier: bigint,
        scope: bigint
    ) {
        const proof = makeProof(f, { nullifier, proposalScope: scope });
        return proposal.interface.encodeFunctionData("castVote", [proof]);
    }

    // ============================================================
    // 1. ★ 身份泄露判定（决定为什么不用 ERC-2771）
    // ============================================================
    describe("★ 身份泄露判定（证据，不可删除）", function () {
        async function metaTxFixture() {
            const [admin, relayer, outsider] = await ethers.getSigners();

            const forwarder = await (
                await ethers.getContractFactory("ERC2771LeakReference")
            ).deploy();
            await forwarder.waitForDeployment();
            const forwarderAddr = await forwarder.getAddress();

            const target = await (
                await ethers.getContractFactory("LeakTargetProbe")
            ).deploy(forwarderAddr);
            await target.waitForDeployment();

            const signer = ethers.Wallet.createRandom();
            const network = await ethers.provider.getNetwork();

            return {
                forwarder,
                forwarderAddr,
                target,
                signer,
                admin,
                relayer,
                outsider,
                domain: {
                    name: "ChainVoteForwarder",
                    version: "1",
                    chainId: network.chainId,
                    verifyingContract: forwarderAddr,
                },
            };
        }

        it("★ 经 ERC-2771 转发的交易，calldata 中必然含签名者地址", async function () {
            const f = await loadFixture(metaTxFixture);

            const request = {
                from: f.signer.address,
                to: await f.target.getAddress(),
                value: 0n,
                gas: 200_000n,
                nonce: await f.forwarder.nonces(f.signer.address),
                deadline: BigInt(await time.latest()) + 3600n,
                data: f.target.interface.encodeFunctionData("record", [42n]),
            };
            const signature = await f.signer.signTypedData(
                f.domain,
                FORWARD_REQUEST_TYPES,
                request
            );

            const receipt = await (
                await f.forwarder.connect(f.outsider).execute({ ...request, signature })
            ).wait();
            const onchain = await ethers.provider.getTransaction(receipt!.hash);

            const calldata = onchain!.data.toLowerCase();
            // 地址在 ABI 编码中按 32 字节右对齐存放
            const signerWord = f.signer.address.toLowerCase().slice(2).padStart(64, "0");
            const leaked = calldata.includes(signerWord);

            console.log("");
            console.log("        ┌─ ERC-2771 身份泄露实测 ───────────────────────────");
            console.log(`        │ 交易 from（原生发送者）:  ${onchain!.from}`);
            console.log(`        │ 签名者（被代表的用户）:   ${f.signer.address}`);
            console.log(`        │ 交易 calldata 长度:       ${(calldata.length - 2) / 2} 字节`);
            console.log(`        │ 签名者地址出现于 calldata: ${leaked ? "★ 是" : "否"}`);
            console.log("        └──────────────────────────────────────────────────");
            console.log("        ⇒ 结论：ERC-2771 隐藏的是「谁付 gas」，不是「谁在操作」。");
            console.log("          其设计目标是让目标合约识别真实用户，与隐身份目标相反。");

            expect(leaked).to.equal(true);
        });

        it("对照：纯中继（只提交 proof）的 calldata 中不含任何账户地址", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.proposal.SCOPE();
            const data = await castVoteData(f, f.proposal, 11n, scope);

            const receipt = await (
                await f.relayer.sendTransaction({ to: await f.proposal.getAddress(), data })
            ).wait();
            const onchain = await ethers.provider.getTransaction(receipt!.hash);

            const calldata = onchain!.data.toLowerCase();
            const accounts = [f.relayer.address, f.outsider.address, f.enrolledVoter.address];

            console.log("");
            console.log("        ┌─ 纯中继对照 ──────────────────────────────────────");
            console.log(`        │ 交易 from: ${onchain!.from}（中继账户）`);
            for (const a of accounts) {
                const w = a.toLowerCase().slice(2).padStart(64, "0");
                console.log(`        │ ${a} 出现于 calldata: ${calldata.includes(w)}`);
            }
            console.log("        └──────────────────────────────────────────────────");

            for (const a of accounts) {
                const w = a.toLowerCase().slice(2).padStart(64, "0");
                expect(calldata.includes(w)).to.equal(false);
            }
        });
    });

    // ============================================================
    // 2. ★ 匿名准入强制（合约层保证）
    // ============================================================
    describe("★ 匿名准入强制", function () {
        it("★ 已登记地址直接提交投票被拒 —— MustUseRelayer", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.proposal.SCOPE();
            const data = await castVoteData(f, f.proposal, 21n, scope);

            // outsider 的地址已在名册中 —— 若允许其提交，地址与选票即公开关联
            expect(await f.registry.isRegistered(f.outsider.address)).to.equal(true);
            await expect(
                f.outsider.sendTransaction({ to: await f.proposal.getAddress(), data })
            ).to.be.revertedWithCustomError(f.proposal, "MustUseRelayer");
        });

        it("未登记的中继账户可正常提交", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            expect(await f.registry.isRegistered(f.relayer.address)).to.equal(false);
            const data = await castVoteData(f, f.proposal, 22n, await f.proposal.SCOPE());
            await f.relayer.sendTransaction({ to: await f.proposal.getAddress(), data });

            expect(await f.proposal.nullifierCount()).to.equal(1n);
        });

        it("★ 一次性地址自任中继亦可提交（不依赖平台中继，且仍匿名）", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            // 选民自建一个从未与身份关联的一次性账户，自付 gas 提交
            const oneTime = ethers.Wallet.createRandom().connect(ethers.provider);
            await f.admin.sendTransaction({ to: oneTime.address, value: ethers.parseEther("1") });

            const data = await castVoteData(f, f.proposal, 23n, await f.proposal.SCOPE());
            const receipt = await (
                await (oneTime as any).sendTransaction({
                    to: await f.proposal.getAddress(),
                    data,
                })
            ).wait();

            const onchain = await ethers.provider.getTransaction(receipt!.hash);
            expect(await f.proposal.nullifierCount()).to.equal(1n);
            // 交易发起者是一次性地址，链上无法关联到任何已登记身份
            expect(onchain!.from.toLowerCase()).to.equal(oneTime.address.toLowerCase());
            expect(await f.registry.isRegistered(onchain!.from)).to.equal(false);
        });

        it("准入检查在时间窗前先执行（无效入口不消耗后续校验的 gas）", async function () {
            const f = await loadFixture(deployFixture);
            // 投票期尚未开始
            const data = await castVoteData(f, f.proposal, 24n, await f.proposal.SCOPE());
            // 已登记地址 + 时间窗未开：应报 MustUseRelayer（准入优先），而非 VotingNotOpen
            await expect(
                f.outsider.sendTransaction({ to: await f.proposal.getAddress(), data })
            ).to.be.revertedWithCustomError(f.proposal, "MustUseRelayer");
        });
    });

    // ============================================================
    // 3. 纯中继下的重放防护（F-10 的等价物）
    // ============================================================
    describe("★ 纯中继下的重放防护", function () {
        it("同一 proof 重复提交被拒（nullifier 唯一性）", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            const scope = await f.proposal.SCOPE();
            const data = await castVoteData(f, f.proposal, 31n, scope);

            await f.relayer.sendTransaction({ to: await f.proposal.getAddress(), data });
            await expect(
                f.relayer.sendTransaction({ to: await f.proposal.getAddress(), data })
            ).to.be.revertedWithCustomError(f.proposal, "AlreadyVoted");
        });

        it("同一 proof 提交到另一提案被拒（scope 绑定）", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            // 用提案 A 的 scope 构造 calldata，投给提案 B
            const data = await castVoteData(f, f.proposal2, 32n, await f.proposal.SCOPE());

            await expect(
                f.relayer.sendTransaction({ to: await f.proposal2.getAddress(), data })
            ).to.be.revertedWithCustomError(f.proposal2, "InvalidScope");
        });

        it("两个提案的 scope 互不相同（域分隔生效）", async function () {
            const f = await loadFixture(deployFixture);
            expect(await f.proposal.SCOPE()).to.not.equal(await f.proposal2.SCOPE());
        });

        it("中继无法篡改选票内容：篡改承诺即证明失败", async function () {
            const f = await loadFixture(deployFixture);
            await time.increaseTo(f.votingStart + 10n);

            await f.mockVerifier.setAlwaysAccept(false);
            const data = await castVoteData(f, f.proposal, 33n, await f.proposal.SCOPE());

            await expect(
                f.relayer.sendTransaction({ to: await f.proposal.getAddress(), data })
            ).to.be.revertedWithCustomError(f.proposal, "InvalidProof");
        });
    });

    // ============================================================
    // 4. ERC-2771 参照组（保留知识，避免误判为「不安全」）
    // ============================================================
    describe("ERC-2771 参照：其重放防护本身是完整的", function () {
        async function fixture() {
            const [admin, relayer, outsider] = await ethers.getSigners();
            const forwarder = await (
                await ethers.getContractFactory("ERC2771LeakReference")
            ).deploy();
            await forwarder.waitForDeployment();
            const forwarderAddr = await forwarder.getAddress();
            const target = await (
                await ethers.getContractFactory("LeakTargetProbe")
            ).deploy(forwarderAddr);
            await target.waitForDeployment();
            const target2 = await (
                await ethers.getContractFactory("LeakTargetProbe")
            ).deploy(forwarderAddr);
            await target2.waitForDeployment();

            const signer = ethers.Wallet.createRandom();
            const network = await ethers.provider.getNetwork();
            const domain = {
                name: "ChainVoteForwarder",
                version: "1",
                chainId: network.chainId,
                verifyingContract: forwarderAddr,
            };

            async function sign(overrides: Record<string, unknown> = {}) {
                const request = {
                    from: signer.address,
                    to: await target.getAddress(),
                    value: 0n,
                    gas: 200_000n,
                    nonce: await forwarder.nonces(signer.address),
                    deadline: BigInt(await time.latest()) + 3600n,
                    data: target.interface.encodeFunctionData("record", [7n]),
                    ...overrides,
                };
                const signature = await signer.signTypedData(domain, FORWARD_REQUEST_TYPES, request);
                return { request, signature };
            }

            return { forwarder, target, target2, signer, domain, sign, admin, relayer, outsider };
        }

        it("同签名换 calldata 被拒（keccak256(data) 已入类型哈希）", async function () {
            const f = await loadFixture(fixture);
            const { request, signature } = await f.sign();
            const tampered = {
                ...request,
                data: f.target.interface.encodeFunctionData("record", [8n]),
            };
            await expect(
                f.forwarder.connect(f.outsider).execute({ ...tampered, signature })
            ).to.be.revertedWithCustomError(f.forwarder, "ERC2771ForwarderInvalidSigner");
        });

        it("换目标合约被拒（to 已入类型哈希）", async function () {
            const f = await loadFixture(fixture);
            const { request, signature } = await f.sign();
            const tampered = { ...request, to: await f.target2.getAddress() };
            await expect(
                f.forwarder.connect(f.outsider).execute({ ...tampered, signature })
            ).to.be.revertedWithCustomError(f.forwarder, "ERC2771ForwarderInvalidSigner");
        });

        it("过期签名被拒（deadline）", async function () {
            const f = await loadFixture(fixture);
            const { request, signature } = await f.sign({ deadline: 1n });
            await expect(
                f.forwarder.connect(f.outsider).execute({ ...request, signature })
            ).to.be.revertedWithCustomError(f.forwarder, "ERC2771ForwarderExpiredRequest");
        });

        it("重放同一签名被拒（nonce 已消费）", async function () {
            const f = await loadFixture(fixture);
            const signed = await f.sign();
            await f.forwarder
                .connect(f.outsider)
                .execute({ ...signed.request, signature: signed.signature });
            await expect(
                f.forwarder
                    .connect(f.outsider)
                    .execute({ ...signed.request, signature: signed.signature })
            ).to.be.revertedWithCustomError(f.forwarder, "ERC2771ForwarderInvalidSigner");
        });

        it("from 与签名者不符被拒", async function () {
            const f = await loadFixture(fixture);
            const { request, signature } = await f.sign();
            const tampered = { ...request, from: f.outsider.address };
            await expect(
                f.forwarder.connect(f.outsider).execute({ ...tampered, signature })
            ).to.be.revertedWithCustomError(f.forwarder, "ERC2771ForwarderInvalidSigner");
        });

        it("未信任该中继的目标合约会拒绝转发（防止被当作任意 call 代理）", async function () {
            const f = await loadFixture(fixture);
            // 部署一个不信任该中继的探针
            const other = await (
                await ethers.getContractFactory("LeakTargetProbe")
            ).deploy(f.outsider.address);
            await other.waitForDeployment();

            const { request, signature } = await f.sign({ to: await other.getAddress() });
            await expect(
                f.forwarder.connect(f.outsider).execute({ ...request, signature })
            ).to.be.revertedWithCustomError(f.forwarder, "ERC2771UntrustfulTarget");
        });
    });
});
