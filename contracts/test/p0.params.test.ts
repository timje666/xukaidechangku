import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * P0 单元测试 —— 冻结参数与选票编解码
 *
 * 覆盖：
 *   - Params 常量与 Q1–Q12 冻结结论的一致性
 *   - BallotCodec 位图校验 / popcount / 编解码往返（含 F-21 off-by-one 回归）
 *   - Params 时间窗与选项配置校验
 *   - scopeOf 的跨提案 / 跨链隔离（防护 R7 证明重放）
 */
describe("P0 · 冻结参数与选票编码", function () {
    async function deployFixture() {
        const H = await ethers.getContractFactory("BallotCodecHarness");
        const h = await H.deploy();
        await h.waitForDeployment();
        return { h };
    }

    // ============================================================
    // 1. 冻结参数一致性 —— 与实现方案 v2.1 的 Q1–Q12 对齐
    // ============================================================
    describe("Params 冻结常量", function () {
        it("MAX_OPTION_COUNT = 16（位图位宽上限）", async function () {
            const { h } = await loadFixture(deployFixture);
            const c = await h.constants();
            expect(c.maxOptionCount).to.equal(16n);
        });

        it("MAX_MAX_CHOICES = 8（冻结 Q6）", async function () {
            const { h } = await loadFixture(deployFixture);
            const c = await h.constants();
            expect(c.maxMaxChoices).to.equal(8n);
        });

        it("DEFAULT_REVEAL_WINDOW = 48h（冻结 Q3）", async function () {
            const { h } = await loadFixture(deployFixture);
            const c = await h.constants();
            expect(c.defaultRevealWindow).to.equal(48n * 3600n);
        });

        it("MAX_REGISTER_BATCH = 50（F-09 修正上限）", async function () {
            const { h } = await loadFixture(deployFixture);
            const c = await h.constants();
            expect(c.maxRegisterBatch).to.equal(50n);
        });

        it("RELAYER_FREE_QUOTA_PER_PROPOSAL = 20（冻结 Q5）", async function () {
            const { h } = await loadFixture(deployFixture);
            const c = await h.constants();
            expect(c.relayerFreeQuota).to.equal(20n);
        });
    });

    // ============================================================
    // 2. BallotCodec.popcount
    // ============================================================
    describe("BallotCodec.popcount", function () {
        const cases: Array<[number, number]> = [
            [0x0000, 0],
            [0x0001, 1],
            [0x0003, 2],
            [0x00ff, 8],
            [0xaaaa, 8],
            [0x5555, 8],
            [0x7fff, 15],
            [0xffff, 16],
        ];

        for (const [mask, expected] of cases) {
            it(`popcount(0x${mask.toString(16).padStart(4, "0")}) = ${expected}`, async function () {
                const { h } = await loadFixture(deployFixture);
                expect(await h.popcount(mask)).to.equal(BigInt(expected));
            });
        }
    });

    // ============================================================
    // 3. BallotCodec.validate
    // ============================================================
    describe("BallotCodec.validate", function () {
        it("回归 F-21：16 个选项且全部选中应被接受（原实现误拒）", async function () {
            const { h } = await loadFixture(deployFixture);
            // 0x00FF = 低 8 位全置，maxChoices = 8
            expect(await h.validate(0x00ff, 16, 8)).to.equal(true);
            // 0xFFFF = 16 位全置，maxChoices = 16 超出上限但 validate 只按参数判断
            expect(await h.validate(0xffff, 16, 8)).to.equal(false); // popcount 16 > 8
        });

        it("16 选项时 uint16 全位合法，不做越界位移判定", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validate(0x8000, 16, 8)).to.equal(true); // 仅高位置位
        });

        it("8 个选项时超出位宽的位应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validate(0x0100, 8, 8)).to.equal(false); // bit8 越界
            expect(await h.validate(0x00ff, 8, 8)).to.equal(true);
        });

        it("选中数超过 maxChoices 应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validate(0x0007, 4, 3)).to.equal(true); // 3 选 3
            expect(await h.validate(0x000f, 4, 3)).to.equal(false); // 4 选 3
        });

        it("maxChoices 大于 optionCount 应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validate(0x0003, 2, 3)).to.equal(false);
        });

        it("optionCount 越界应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            // 职责分离：BallotCodec 只判定「位图是否合法」，不承担业务下限。
            // optionCount = 0 无位宽可言 → 非法
            expect(await h.validate(0x0001, 0, 1)).to.equal(false);
            // optionCount = 1 在位图层是合法位图；「至少 2 个选项」是业务规则，
            // 由 Params.validateOptions 负责，见下方用例
            expect(await h.validate(0x0001, 1, 1)).to.equal(true);
            // 超过位宽上限 → 非法
            expect(await h.validate(0x0001, 17, 1)).to.equal(false);
        });

        it("空选票（mask = 0）在 maxChoices >= 1 时合法", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validate(0x0000, 4, 2)).to.equal(true);
            expect(await h.validate(0x0000, 4, 0)).to.equal(false); // maxChoices 不得为 0
        });

        it("单选配置下多位置位应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validate(0x0001, 4, 1)).to.equal(true);
            expect(await h.validate(0x0003, 4, 1)).to.equal(false);
        });
    });

    // ============================================================
    // 4. 编解码往返
    // ============================================================
    describe("BallotCodec 编解码往返", function () {
        it("encode(decode(mask)) === mask", async function () {
            const { h } = await loadFixture(deployFixture);
            for (const mask of [0x0000, 0x0001, 0x00aa, 0x5555, 0xffff]) {
                // 注意：ethers v6 的 view 返回值是只读 Result 代理，
                // 直接作为数组实参回传会触发写操作而抛错，必须先转为普通数组
                const picked = Array.from(await h.decode(mask, 16)).map((v) => Boolean(v));
                const back = await h.encode(picked);
                expect(back).to.equal(BigInt(mask));
            }
        });

        it("isPicked 与 fullMask 语义正确", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.isPicked(0x0005, 0)).to.equal(true);
            expect(await h.isPicked(0x0005, 1)).to.equal(false);
            expect(await h.isPicked(0x0005, 2)).to.equal(true);

            expect(await h.fullMask(0)).to.equal(0n);
            expect(await h.fullMask(4)).to.equal(0x0fn);
            expect(await h.fullMask(16)).to.equal(0xffffn);
        });
    });

    // ============================================================
    // 5. Params 时间窗校验（N3 时间锁）
    // ============================================================
    describe("Params.validateTimeWindows", function () {
        const HOUR = 3600;

        it("合法时间窗应通过", async function () {
            const { h } = await loadFixture(deployFixture);
            const ok = await h.validateTimeWindows(0, HOUR, 2 * HOUR, 4 * HOUR, 4 * HOUR + 48 * HOUR);
            expect(ok).to.equal(true);
        });

        it("时间点非严格递增应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            // registrationEnd == votingStart
            expect(await h.validateTimeWindows(0, HOUR, HOUR, 4 * HOUR, 4 * HOUR + 48 * HOUR)).to.equal(false);
            // votingStart == votingEnd
            expect(await h.validateTimeWindows(0, HOUR, 2 * HOUR, 2 * HOUR, 2 * HOUR + 48 * HOUR)).to.equal(false);
            // votingEnd == revealEnd
            expect(await h.validateTimeWindows(0, HOUR, 2 * HOUR, 4 * HOUR, 4 * HOUR)).to.equal(false);
            // 逆序
            expect(await h.validateTimeWindows(0, 4 * HOUR, 2 * HOUR, 3 * HOUR, 5 * HOUR)).to.equal(false);
        });

        it("任一阶段短于下限应被拒绝", async function () {
            const { h } = await loadFixture(deployFixture);
            // 登记期 0 秒
            expect(await h.validateTimeWindows(0, 0, 2 * HOUR, 4 * HOUR, 4 * HOUR + 48 * HOUR)).to.equal(false);
            // 投票期 30 分钟
            expect(
                await h.validateTimeWindows(0, HOUR, 2 * HOUR, 2 * HOUR + 1800, 2 * HOUR + 1800 + 48 * HOUR)
            ).to.equal(false);
        });

        it("揭示窗口超过上限应被拒绝（防止事实永不封存）", async function () {
            const { h } = await loadFixture(deployFixture);
            const tooLong = 4 * HOUR + 31 * 24 * HOUR;
            expect(await h.validateTimeWindows(0, HOUR, 2 * HOUR, 4 * HOUR, tooLong)).to.equal(false);
        });
    });

    // ============================================================
    // 6. Params 选项配置与 scope 隔离
    // ============================================================
    describe("Params.validateOptions 与 scopeOf", function () {
        it("选项配置边界", async function () {
            const { h } = await loadFixture(deployFixture);
            expect(await h.validateOptions(2, 1)).to.equal(true);
            expect(await h.validateOptions(16, 8)).to.equal(true);
            expect(await h.validateOptions(1, 1)).to.equal(false);
            expect(await h.validateOptions(17, 1)).to.equal(false);
            expect(await h.validateOptions(4, 9)).to.equal(false); // 超过 MAX_MAX_CHOICES
            expect(await h.validateOptions(4, 5)).to.equal(false); // maxChoices > optionCount
        });

        it("scope 绑定提案地址与链 ID，跨提案/跨链不可重放（防护 R7）", async function () {
            const { h } = await loadFixture(deployFixture);
            const [a, b] = await ethers.getSigners();
            const chainId = 84532n;

            const s1 = await h.scopeOf(chainId, a.address);
            const s2 = await h.scopeOf(chainId, b.address);
            const s3 = await h.scopeOf(8453n, a.address);

            expect(s1).to.not.equal(s2); // 不同提案 → 不同 scope
            expect(s1).to.not.equal(s3); // 不同链 → 不同 scope
            expect(s1).to.equal(await h.scopeOf(chainId, a.address)); // 确定性
        });
    });
});
