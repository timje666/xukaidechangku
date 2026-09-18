// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../libs/BallotCodec.sol";
import "../libs/Params.sol";

/// @title BallotCodecHarness —— 测试夹具
/// @notice library 的 internal 函数无法从外部调用，此处仅做参数转发，
///         不包含任何业务逻辑（业务逻辑一律留在 BallotCodec / Params 内）
contract BallotCodecHarness {
    function validate(uint16 mask, uint8 optionCount, uint8 maxChoices) external pure returns (bool) {
        return BallotCodec.validate(mask, optionCount, maxChoices);
    }

    function popcount(uint16 x) external pure returns (uint8) {
        return BallotCodec.popcount(x);
    }

    function decode(uint16 mask, uint8 optionCount) external pure returns (bool[] memory) {
        return BallotCodec.decode(mask, optionCount);
    }

    function encode(bool[] calldata picked) external pure returns (uint16) {
        bool[] memory p = new bool[](picked.length);
        for (uint256 i = 0; i < picked.length; ++i) {
            p[i] = picked[i];
        }
        return BallotCodec.encode(p);
    }

    function isPicked(uint16 mask, uint8 i) external pure returns (bool) {
        return BallotCodec.isPicked(mask, i);
    }

    function fullMask(uint8 optionCount) external pure returns (uint16) {
        return BallotCodec.fullMask(optionCount);
    }

    // ---- Params ----

    function validateTimeWindows(
        uint64 now_,
        uint64 registrationEnd,
        uint64 votingStart,
        uint64 votingEnd,
        uint64 revealEnd
    ) external pure returns (bool) {
        return Params.validateTimeWindows(now_, registrationEnd, votingStart, votingEnd, revealEnd);
    }

    function validateOptions(uint8 optionCount, uint8 maxChoices) external pure returns (bool) {
        return Params.validateOptions(optionCount, maxChoices);
    }

    function scopeOf(uint256 chainId, address proposal) external pure returns (uint256) {
        return Params.scopeOf(chainId, proposal);
    }

    function constants()
        external
        pure
        returns (
            uint8 maxOptionCount,
            uint8 maxMaxChoices,
            uint64 defaultRevealWindow,
            uint256 maxRegisterBatch,
            uint256 relayerFreeQuota
        )
    {
        return (
            Params.MAX_OPTION_COUNT,
            Params.MAX_MAX_CHOICES,
            Params.DEFAULT_REVEAL_WINDOW,
            Params.MAX_REGISTER_BATCH,
            Params.RELAYER_FREE_QUOTA_PER_PROPOSAL
        );
    }
}
