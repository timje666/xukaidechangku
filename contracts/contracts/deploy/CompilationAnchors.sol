// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// 仅为把 SemaphoreVerifier 的具体实现拉入编译图而 import。
// 若无人 import 具体实现，Hardhat 不会为其产出 artifact，
// `getContractFactory("SemaphoreVerifier")` 会报 HH700 —— 部署脚本与测试都会卡住。
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";

/// @title CompilationAnchors —— 编译锚点
/// @notice 空合约，唯一作用是让上述 import 生效，从而为 `SemaphoreVerifier` 产出 artifact。
///         供 P4 测试与 P8 部署脚本通过 `getContractFactory("SemaphoreVerifier")` 使用。
///
/// @dev 为什么不写一个「在链上部署验证器」的工厂合约：
///      **实测：这样的工厂无法部署。** `new SemaphoreVerifier()` 会把验证器的
///      创建字节码整体嵌入工厂字节码，实测工厂达到 **30,708 字节**，
///      超过 EIP-170 的 24,576 字节上限，部署必然失败。
///      ⇒ 验证器的部署改为在**链下脚本**中直接 `deploy()`，
///        不经过任何链上工厂合约。
///
/// @dev 本合约不含逻辑、不部署到任何网络。
/// @author ChainVote
contract CompilationAnchors {
    /// @notice 引用验证器类型，确保其进入编译产物
    /// @return 验证器合约名（编译期常量，无运行时开销）
    function verifierContractName() external pure returns (string memory) {
        return type(SemaphoreVerifier).name;
    }
}
