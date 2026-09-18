// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {LeanIMTData, InternalLeanIMT} from "@zk-kit/lean-imt.sol/InternalLeanIMT.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

/// @title DependencyProbe —— 第三方依赖兼容性探针
/// @notice L5 验证产物。本合约不参与业务，唯一作用是让依赖的**可编译性与 API 形状**
///         在每次 `hardhat compile` 时被强制校验：一旦 Semaphore / LeanIMT / Poseidon
///         升级导致 API 变动或与 solc 0.8.24 不兼容，编译立即失败，
///         而不是等到 P4 集成时才暴露。
///
/// @dev 关键决策记录（L5 验证结论，供 P2 直接采用）：
///
///      **1. 使用 `InternalLeanIMT` 而非 `LeanIMT`**
///      `LeanIMT.sol` 的同名函数是 `public`，调用产生库链接引用；
///      `InternalLeanIMT` 的同名函数是 `internal`，编译期内联。
///      选用后者可**少一层**库链接（LeanIMT 本身），但**不能消除**链接依赖——见第 3 条。
///
///      **2. 本版本的 LeanIMT 不提供 generateProof / verifyProof**
///      成员证明的生成必须在**链下**完成（zk-kit 的 lean-imt JS 包），
///      链上校验由 ZK 电路承担——合约只需比对 `proof.merkleTreeRoot` 与冻结根，
///      **不需要在链上重算 Merkle 路径**。这对 P3 的 `castVote` 实现是决定性简化。
///
///      **3. 【实测更正】PoseidonT3 链接依赖无法避免**
///      原假设「使用 InternalLeanIMT 即可单合约部署」**已被实测否定**：
///      `InternalLeanIMT._insert` 内部调用 `PoseidonT3.hash(...)`，
///      而 poseidon-solidity 的 `PoseidonT3.hash` 是 `public` 函数，
///      因此**任何在链上维护 Semaphore 兼容 Merkle 树的合约都必须链接 PoseidonT3**。
///      ⇒ P8 部署脚本必须：**先部署 PoseidonT3 库 → 记录地址 → 再部署业务合约并传入库地址**。
///      ⇒ 区块浏览器验证时需一并提供库地址。
///      该要求已在 `scripts/check-link-references.mjs` 中登记为**预期依赖**。
///
///      **4. 链下树与链上树必须逐位一致**
///      链上只保存 `sideNodes` 与 `size`，链下必须**按相同插入顺序**重放。
///      因此 VoterRegistry 必须在每次插入时发出带序号的索引事件，
///      供链下按序重建（该约束已写入 P2 设计）。
contract DependencyProbe {
    using InternalLeanIMT for LeanIMTData;

    LeanIMTData private _tree;

    event LeafInserted(uint256 indexed index, uint256 leaf, uint256 newRoot, uint256 size);

    /// @notice 插入单个叶子（选民承诺）
    /// @param leaf 叶子值，须落在 SNARK 标量域内
    /// @return newRoot 插入后的树根
    function insert(uint256 leaf) external returns (uint256 newRoot) {
        uint256 index = _tree.size;
        newRoot = _tree._insert(leaf);
        emit LeafInserted(index, leaf, newRoot, _tree.size);
    }

    /// @notice 批量插入（P2 的 registerVoters 会走这条路径）
    function insertMany(uint256[] calldata leaves) external returns (uint256 newRoot) {
        newRoot = _tree._insertMany(leaves);
    }

    function root() external view returns (uint256) {
        return _tree._root();
    }

    function size() external view returns (uint256) {
        return _tree.size;
    }

    function depth() external view returns (uint256) {
        return _tree.depth;
    }

    function has(uint256 leaf) external view returns (bool) {
        return _tree._has(leaf);
    }

    function indexOf(uint256 leaf) external view returns (uint256) {
        return _tree._indexOf(leaf);
    }

    /// @notice 验证 Semaphore 验证器接口可被引用（P4 依赖）
    function verifierInterfaceId() external pure returns (bytes4) {
        return type(ISemaphoreVerifier).interfaceId;
    }
}
