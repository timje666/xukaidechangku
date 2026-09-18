// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @title ERC2771LeakReference —— 「为何不用 ERC-2771」的证据性参照
/// @notice **不参与任何生产部署**。唯一用途是让 `test/p5.metatx.test.ts`
///         能实例化一个**真实的** OpenZeppelin 中继，从而可复现地证明：
///
///         **经 ERC-2771 转发的交易，会把签名者地址明文写入交易 calldata。**
///
/// @dev 为什么必须留下可执行证据，而不是删掉代码后在文档里写一句结论：
///
///      初版方案（`区块链去中心化投票系统-实现方案-v2.md` §5.3）选择
///      `MinimalForwarder` + ERC-2771，理由「Relayer 是全匿名的必要条件」。
///      该判断**方向上部分正确、机制上完全错误**：
///        · 需要中继（relayer）是对的 —— 选民不能自己发交易；
///        · 用 ERC-2771 是错的 —— 它的设计目标是让目标合约**识别出真实用户**
///          （`_msgSender()` 返回签名者），而全匿名要求合约**无法识别用户**，两者目标相反。
///
///      机制上，`ERC2771Forwarder._execute` 执行
///      `abi.encodePacked(request.data, request.from)`，且 `request.from`
///      本身就是 `execute()` calldata 的一部分。实测一笔 868 字节的中继调用，
///      签名者地址完整出现于其 calldata 中。
///
///      ⇒ 若只写结论，后续维护者可能「为了标准化」而重新引入 ERC-2771。
///        保留可执行证据，任何人可在 1 秒内重新验证该判断。
///      ⇒ 同时须澄清：**ERC-2771 本身没有安全缺陷**（见 `test/p5.metatx.test.ts`
///        的「其重放防护完整」用例组）。不采用它是因为**机制与隐私目标相冲突**，
///        而非质量原因——这个区分可避免它被错误地拒绝于适用场景（如免 gas 的
///        公开治理投票、NFT 空投领取等不需要匿名的场合）。
///
/// @dev 【禁止】将本合约或其父合约用于 `Proposal` 的投票路径。
///      匿名投票中继必须是**纯中继**：中继账户直接调用 `castVote(proof)`，
///      calldata 中只含证明，不含任何地址。
///
/// @author ChainVote
contract ERC2771LeakReference is ERC2771Forwarder {
    /// @notice 仅供测试实例化。域名固定，避免测试与实现漂移
    constructor() ERC2771Forwarder("ChainVoteForwarder") {}
}

/// @title LeakTargetProbe —— 泄露复现用的最小目标合约
/// @notice 仅声明 `isTrustedForwarder`（`ERC2771Forwarder._isTrustedByTarget` 的前置条件）
///         与一个可被转发的空函数。刻意**不继承** `ERC2771Context`：
///         本探针只需让转发成功发生，以便观察交易 calldata，无需处理 `_msgSender()` 语义。
/// @dev 不参与生产部署。
/// @author ChainVote
contract LeakTargetProbe {
    /// @notice 被信任的中继地址
    address public immutable trusted;

    /// @notice 最近一次被转发调用的实参，仅用于确认转发确实执行
    uint256 public lastValue;

    /// @param trusted_ 被本探针信任的中继地址
    constructor(address trusted_) {
        trusted = trusted_;
    }

    /// @notice ERC-2771 要求的可信中继查询接口
    /// @param forwarder 待查询地址
    /// @return 该地址为可信中继时返回 true
    function isTrustedForwarder(address forwarder) external view returns (bool) {
        return forwarder == trusted;
    }

    /// @notice 被转发的空函数
    /// @param v 任意值，仅用于确认调用到达
    function record(uint256 v) external {
        lastValue = v;
    }
}
