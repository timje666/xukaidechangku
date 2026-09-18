// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./Params.sol";

/// @title BallotCodec —— 选票位图编解码
/// @notice 多选（D4）以 uint16 位图承载：bit i = 1 表示选中第 i 个选项
/// @dev 本库为纯函数，无状态、无外部调用，可被 reveal 与测试直接复用
library BallotCodec {
    /// @notice 位图合法：位宽不越界 且 选中数不超限
    /// @dev 修订 F-21：原实现 `if (optionCount >= 16) return false;` 为 off-by-one，
    ///      会错误拒绝 16 选项的合法配置。此处改为 `> 16`。
    function validate(uint16 mask, uint8 optionCount, uint8 maxChoices) internal pure returns (bool) {
        if (optionCount == 0 || optionCount > Params.MAX_OPTION_COUNT) return false;
        if (maxChoices == 0 || maxChoices > optionCount) return false;

        // 越界位检查：optionCount == 16 时 uint16 全部位合法，无需位移比较
        if (optionCount < Params.MAX_OPTION_COUNT) {
            if (mask >> optionCount != 0) return false;
        }

        return popcount(mask) <= maxChoices;
    }

    /// @notice 统计置位数量（选中项数）
    /// @dev 循环上界固定为 16 轮，无 gas 爆炸风险（G12）
    function popcount(uint16 x) internal pure returns (uint8 c) {
        while (x != 0) {
            c += uint8(x & 1);
            x >>= 1;
        }
    }

    /// @notice 将选中项展开为布尔数组，供 UI 与测试使用
    function decode(uint16 mask, uint8 optionCount) internal pure returns (bool[] memory picked) {
        picked = new bool[](optionCount);
        for (uint8 i = 0; i < optionCount; ++i) {
            picked[i] = (mask & (uint16(1) << i)) != 0;
        }
    }

    /// @notice 由布尔数组编码为位图
    function encode(bool[] memory picked) internal pure returns (uint16 mask) {
        for (uint256 i = 0; i < picked.length && i < Params.MAX_OPTION_COUNT; ++i) {
            if (picked[i]) mask |= uint16(1) << uint16(i);
        }
    }

    /// @notice 判定掩码中是否选中第 i 项
    function isPicked(uint16 mask, uint8 i) internal pure returns (bool) {
        return (mask & (uint16(1) << i)) != 0;
    }

    /// @notice 全选项集合的掩码（如 optionCount = 16 时为 0xFFFF）
    function fullMask(uint8 optionCount) internal pure returns (uint16) {
        if (optionCount == 0) return 0;
        if (optionCount >= Params.MAX_OPTION_COUNT) return type(uint16).max;
        return uint16((uint16(1) << optionCount) - 1);
    }
}
