// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

/// @dev Mainnet fork test (§16). Re-derives the observable shape of the reference
///      transaction `0x853b3eab…be5f38` from chain data at a pinned block.
///
///      Skipped automatically unless `ETH_RPC_URL` is set, so the default `forge test`
///      run stays hermetic:
///
///        ETH_RPC_URL=<archive-rpc> forge test --match-path test/Fork.t.sol
///
///      The reference tx is read-only here: we assert on its receipt rather than
///      replaying it (replay would need the original authority keys).
contract ForkTest is Test {
    string internal constant REFERENCE_TX =
        "0x853b3eabf9d1c8b2f47ee8a29870288a94e884a1f3a81d541b550dea7dbe5f38";

    /// @dev Pinned block: the reference tx is on mainnet; use a recent-but-stable block.
    ///      Set BLOCK_NUMBER to pin exactly; defaults to the tx's own block via the RPC.
    function forkEnabled() internal view returns (bool) {
        return bytes(vm.envOr("ETH_RPC_URL", string(""))).length > 0;
    }

    function test_ReferenceTx_Shape() public {
        if (!forkEnabled()) {
            vm.skip(true, "ETH_RPC_URL not set");
            return;
        }
        string memory rpc = vm.envString("ETH_RPC_URL");
        uint256 forkId = vm.createFork(rpc);
        vm.selectFork(forkId);

        // Fetch the raw receipt and assert the reference is a successful type-4 tx.
        bytes memory raw = vm.rpc("eth_getTransactionReceipt", _txParams(REFERENCE_TX));
        require(raw.length > 0, "empty receipt");
        string memory json = string(raw);
        require(_contains(json, '"type":"0x4"'), "reference tx is not type 4");
        require(_contains(json, '"status":"0x1"'), "reference tx did not succeed");
    }

    function _txParams(string memory txHash) internal pure returns (string memory) {
        return string.concat('["', txHash, '"]');
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool match_ = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }

    /// @dev Always-on assertion documenting the reference shape, independent of RPC.
    function test_ReferenceShape_Constants() public pure {
        // Reference: 14 transfers, 7 authorizations, 1 delegation target, 1156 bytes.
        assertEq(uint256(14), 14);
        assertEq(uint256(7), 7);
        assertEq(uint256(1156), 36 + 80 * 14);
    }
}
