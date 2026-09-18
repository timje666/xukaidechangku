// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

/// @title MockVerifier —— ZK 验证器测试替身
/// @notice **仅供测试**。在无法生成真实 Groth16 证明的环境中
///         （电路产物 CDN 不可达），用于验证「验证通过之后」的全部状态流转，
///         并**运行时校验 Proposal 构造的公开信号是否与上游一致**。
///
/// @dev 【严禁部署到任何非测试网络】
///      本合约可对任意证明返回 true。若被误当作真实验证器使用，
///      任何人都能伪造选票且系统毫无察觉。P8 部署脚本必须断言
///      `Proposal.VERIFIER` 指向的是官方 SemaphoreVerifier。
///
/// @dev 为什么需要它（两条独立理由）：
///
///      **1. F-05 不变量需要「验证通过」的场景**
///      F-05 规定 `_nullifierUsed` 的写入必须严格晚于验证通过。
///      要断言这一点，必须能构造验证成功的路径；而真实证明的生成依赖
///      电路产物（.wasm/.zkey，数 MB），这些产物不在 npm 包内
///      （zk-kit 的 artifacts 包仅 48 KB），需从 snark-artifacts CDN 下载，
///      该域名在受限网络中不可达。
///
///      **2. 公开信号的构造无法用真实验证器端到端验证**
///      `_verifySemaphoreProof` 必须传
///      `[merkleTreeRoot, nullifier, _hash(message), _hash(scope)]`，
///      其中后两项都要**先哈希再入电路**。若写错（漏哈希、顺序颠倒），
///      真实环境里表现为「所有合法证明都被拒」，但本机无法生成合法证明来发现它。
///      ⇒ `strictMode` 下本替身**自己按上游公式重算**并比对，
///      组成错误则返回 false，测试随即失败。
///
/// @author ChainVote
contract MockVerifier is ISemaphoreVerifier {
    /// @notice 是否接受（未启用 strictMode 时直接决定返回值）
    bool public alwaysAccept = true;

    /// @notice 是否启用公开信号组成的严格校验
    bool public strictMode = false;

    /// @notice 是否模拟「验证器直接 revert」而非返回 false
    /// @dev 真实 SemaphoreVerifier 遇到不在椭圆曲线上的点、或深度不受支持时
    ///      可能直接 revert。Proposal 用 try/catch 把两种失败模式统一收敛为
    ///      `InvalidProof()`——该 catch 分支是安全网，必须被测试触达，
    ///      否则一旦上游改变行为，用户会拿到不可读的底层错误却无人察觉。
    bool public revertMode = false;

    /// @dev 供 revertMode 使用
    error MockVerifierForcedRevert();

    /// @notice 切换「revert 而非返回 false」行为（仅测试用）
    /// @param v true = 直接 revert
    function setRevertMode(bool v) external {
        revertMode = v;
    }

    /// @notice strictMode 下期望的原始 message（未哈希）
    uint256 public expectedMessage;

    /// @notice strictMode 下期望的原始 scope（未哈希）
    uint256 public expectedScope;

    /// @notice strictMode 下期望的 merkleTreeRoot
    uint256 public expectedRoot;

    /// @notice strictMode 下期望的 nullifier
    uint256 public expectedNullifier;

    /// @notice 切换接受/拒绝行为（仅测试用）
    /// @param v true = 一律接受；false = 一律拒绝
    function setAlwaysAccept(bool v) external {
        alwaysAccept = v;
    }

    /// @notice 配置严格模式下的期望值，并启用严格模式（仅测试用）
    /// @param message 期望的原始 message
    /// @param scope 期望的原始 scope
    /// @param root 期望的 merkleTreeRoot
    /// @param nullifier 期望的 nullifier
    function expectSignals(uint256 message, uint256 scope, uint256 root, uint256 nullifier) external {
        expectedMessage = message;
        expectedScope = scope;
        expectedRoot = root;
        expectedNullifier = nullifier;
        strictMode = true;
    }

    /// @notice 关闭严格模式（仅测试用）
    function unsetStrictMode() external {
        strictMode = false;
    }

    /// @dev 与 Semaphore 官方 `Semaphore.sol` 中的 `_hash` 完全一致。
    ///      在此重复实现一份是刻意的：**本替身要用上游公式来校验 Proposal**，
    ///      若直接调用 Proposal 的实现就无法起到交叉验证的作用。
    /// @param x 待哈希值
    /// @return 落在 SNARK 标量域内的哈希值
    function referenceHash(uint256 x) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(x))) >> 8;
    }

    /// @inheritdoc ISemaphoreVerifier
    function verifyProof(
        uint[2] calldata,
        uint[2][2] calldata,
        uint[2] calldata,
        uint[4] calldata _pubSignals,
        uint merkleTreeDepth
    ) external view returns (bool) {
        if (revertMode) revert MockVerifierForcedRevert();

        // 保留对深度参数的最小校验，避免测试中传入完全无意义的深度而毫无察觉
        if (merkleTreeDepth == 0) return false;

        if (strictMode) {
            // 逐项比对：任何一项不符即判为无效证明
            if (_pubSignals[0] != expectedRoot) return false;
            if (_pubSignals[1] != expectedNullifier) return false;
            // ★ 这两行把「必须先哈希」的约束变成运行时可断言的事实
            if (_pubSignals[2] != referenceHash(expectedMessage)) return false;
            if (_pubSignals[3] != referenceHash(expectedScope)) return false;
        }

        return alwaysAccept;
    }
}
