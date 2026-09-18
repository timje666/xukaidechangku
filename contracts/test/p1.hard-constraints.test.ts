import { expect } from "chai";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

/**
 * P1 守卫测试 —— 把「硬约束」变成可执行的检查
 *
 * 为什么需要它：
 *   项目有多条硬约束是「不要做什么」（无暂停权、无 selfdestruct、无 delegatecall、
 *   必须用 custom error 而非 require 字符串）。这类约束在代码评审中极易被漏掉，
 *   且一旦违反，往往到审计阶段才被发现。
 *   本文件把每条「不要」写成源码扫描断言，任何违反都会在 CI 立即失败。
 *
 * 扫描范围：contracts/contracts 目录下的全部 .sol 文件（项目自有合约），
 * 不含依赖（node_modules）与第三方代码。
 *
 * 注意：扫描前会剥离注释，因此**在注释里讨论这些禁用项是允许的**——
 *       这很重要，因为 Roles.sol 与 ChainVoteAccessControl.sol 需要明确记录「为什么没有暂停权」。
 */

/** 剥离 Solidity 注释（行注释与块注释） */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function collectSolidityFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            collectSolidityFiles(p, out);
        } else if (name.endsWith(".sol")) {
            out.push(p);
        }
    }
    return out;
}

interface Rule {
    id: string;
    desc: string;
    pattern: RegExp;
    basis: string;
}

const RULES: Rule[] = [
    {
        id: "HC-10",
        desc: "禁止出现任何暂停类角色（冻结 Q4：无任何管理员干预票期的接口）",
        pattern: /\b(PAUSER_ROLE|PAUSE_ROLE|GUARDIAN_ROLE|EMERGENCY_ROLE|HALTER_ROLE)\b/,
        basis: "冻结 Q4 / v2.1 §5.2 硬约束",
    },
    {
        id: "HC-10b",
        desc: "禁止出现暂停类修饰符或函数",
        pattern: /\b(whenNotPaused|whenPaused)\b|\bfunction\s+(pause|unpause|setPaused|halt)\s*\(/,
        basis: "冻结 Q4",
    },
    {
        id: "HC-11",
        desc: "禁止继承 OpenZeppelin Pausable",
        pattern: /\bPausable\b/,
        basis: "冻结 Q4",
    },
    {
        id: "HC-12",
        desc: "禁止 selfdestruct（上线清单：合约不可被销毁）",
        pattern: /\bselfdestruct\s*\(|\bsuicide\s*\(/,
        basis: "v1 §6.5 上线清单硬约束",
    },
    {
        id: "HC-13",
        desc: "禁止 delegatecall（合约不可升级，无隐藏委托调用）",
        pattern: /\.\s*delegatecall\s*\(/,
        basis: "v2.1 §5.1 不可升级决策",
    },
    {
        id: "HC-14",
        desc: "禁止用 tx.origin 做鉴权",
        pattern: /\btx\s*\.\s*origin\b/,
        basis: "通用 EVM 安全基线",
    },
    {
        id: "HC-15",
        desc: "禁止 require 携带字符串消息（G7：必须使用 custom error）",
        pattern: /require\s*\([^;]*,\s*["']/,
        basis: "v2.1 §9.2 优化点 G7",
    },
    {
        id: "HC-16",
        desc: "禁止内联汇编（降低审计面；如确需使用须在本测试中显式豁免并说明理由）",
        pattern: /\bassembly\s*\{/,
        basis: "内部约定：项目自有合约不使用 assembly",
    },
];

describe("P1 · 硬约束守卫（源码扫描）", function () {
    const root = resolve(__dirname, "..", "contracts");
    let files: string[] = [];

    before(function () {
        files = collectSolidityFiles(root);
        // 自检：必须真的扫到了文件，否则规则会「静默通过」
        expect(files.length, `未在 ${root} 下发现任何 .sol 文件`).to.be.greaterThan(0);
    });

    it("扫描范围覆盖全部项目自有合约", function () {
        const rel = files.map((f) => relative(root, f).replace(/\\/g, "/"));
        // 确保关键文件在扫描范围内，避免路径写错导致规则空转
        expect(rel).to.include("libs/Params.sol");
        expect(rel).to.include("libs/Roles.sol");
        expect(rel).to.include("libs/BallotCodec.sol");
        expect(rel).to.include("libs/Errors.sol");
        expect(rel).to.include("access/ChainVoteAccessControl.sol");
    });

    for (const rule of RULES) {
        it(`${rule.id} · ${rule.desc}`, function () {
            const violations: string[] = [];

            for (const file of files) {
                const code = stripComments(readFileSync(file, "utf8"));
                const lines = code.split(/\r?\n/);
                lines.forEach((line, i) => {
                    if (rule.pattern.test(line)) {
                        violations.push(
                            `${relative(root, file).replace(/\\/g, "/")}:${i + 1}  ${line.trim()}`
                        );
                    }
                });
            }

            expect(
                violations,
                `违反【${rule.id}】（依据：${rule.basis}）：\n  ${violations.join("\n  ")}`
            ).to.deep.equal([]);
        });
    }

    it("注释剥离不影响规则有效性（自检：注入违禁代码必须被捕获）", function () {
        // 若 stripComments 误伤代码，规则会失效却仍然"通过"。此处做反向验证。
        const injected = "function pause() external { } // PAUSER_ROLE 说明";
        const stripped = stripComments(injected);
        const pauseRule = RULES.find((r) => r.id === "HC-10b")!;
        const pauserRule = RULES.find((r) => r.id === "HC-10")!;

        expect(pauseRule.pattern.test(stripped)).to.equal(true); // 代码部分仍被检出
        expect(pauserRule.pattern.test(stripped)).to.equal(false); // 注释部分被正确剥离
    });

    // ============================================================
    // 注释感知规则 —— 必须读取「未剥离注释」的源码
    // ============================================================

    it("HC-17 · NatSpec 注释中不得出现 @包名（会被解析为文档标签导致编译失败）", function () {
        // 实测：在 `///` 注释中写 `@zk-kit/lean-imt`，Solidity 把它当作文档标签，
        // 报 DocstringParsingError 并指向整个注释块起点，排错成本高。
        // 本项目会频繁在注释里引用依赖包名，故设为硬约束。
        const CODEX = /^\s*(?:\/\/\/|\/\*|\*)\s/;
        const PKG = /@[A-Za-z0-9_.-]+\//g;
        const ALLOWED_TAG = /^@(title|notice|dev|param|return|author|inheritdoc|custom|event|error)\b/;

        const violations: string[] = [];
        for (const file of files) {
            const lines = readFileSync(file, "utf8").split(/\r?\n/);
            lines.forEach((line, i) => {
                if (!CODEX.test(line)) return;
                const hits = line.match(PKG);
                if (!hits) return;
                const bad = hits.filter((h) => !ALLOWED_TAG.test(h));
                if (bad.length > 0) {
                    violations.push(
                        `${relative(root, file).replace(/\\/g, "/")}:${i + 1}  ${bad.join(", ")}  ← ${line.trim()}`
                    );
                }
            });
        }

        expect(violations, `违反【HC-17】的注释（依据：实测会导致 DocstringParsingError）：\n  ${violations.join("\n  ")}`).to.deep.equal(
            []
        );
    });

    it("HC-17 自检：注入含 @包名 的注释必须被捕获", function () {
        const CODEX = /^\s*(?:\/\/\/|\/\*|\*)\s/;
        const PKG = /@[A-Za-z0-9_.-]+\//g;
        const ALLOWED_TAG = /^@(title|notice|dev|param|return|author|inheritdoc|custom|event|error)\b/;

        const check = (line: string) => {
            if (!CODEX.test(line)) return [];
            const hits = line.match(PKG) ?? [];
            return hits.filter((h) => !ALLOWED_TAG.test(h));
        };

        expect(check("/// 依赖 zk-kit 的 lean-imt 包")).to.deep.equal([]); // 无反斜杠，合法
        expect(check("/// 使用 @zk-kit/lean-imt 生成").length).to.equal(1); // 命中
        expect(check("/// @param x 参数说明")).to.deep.equal([]); // 合法标签
        expect(check("/// @custom:trace @openzeppelin/contracts 来源").length).to.equal(1); // 尾部包名仍命中
    });
});
