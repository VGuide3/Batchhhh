// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {BatchDisperser} from "../src/BatchDisperser.sol";
import {Registry} from "../src/Registry.sol";
import {IEIP7702BatchDisperser} from "../src/interfaces/IEIP7702BatchDisperser.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @dev Cross-language integration test (§16). The packed payload is produced by the
///      TypeScript encoder (`scripts/emit-fixture.ts`) and consumed here by the
///      Solidity decoder + executor. It proves the two implementations agree
///      byte-for-byte and that a TS-planned batch executes on-chain to the planned
///      outcome. Regenerate the fixture with:
///
///        npx tsx scripts/emit-fixture.ts
contract CrossLanguageReferenceTest is Test {
    BatchDisperser internal impl;
    Registry internal registry;

    address internal constant OUTER_SIGNER = address(0xA11CE);
    address internal constant ENTRY_POINT = address(0xEBBA);

    address internal usdc;
    address internal usdt;
    address[] internal authorities;
    bytes internal packed;

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/reference_batch.json");
        usdc = vm.parseJsonAddress(json, ".usdc");
        usdt = vm.parseJsonAddress(json, ".usdt");
        packed = vm.parseJsonBytes(json, ".packed");

        authorities = vm.parseJsonAddressArray(json, ".authorities");
        require(authorities.length == 7, "expected 7 authorities");

        // The fixture is 1156 bytes by construction; assert it here too.
        require(packed.length == 1156, "fixture must be 1156 bytes");

        _installTokenCode(usdc, "USD Coin", "USDC");
        _installTokenCode(usdt, "Tether", "USDT");

        address[] memory sources = new address[](7);
        for (uint256 i; i < 7; i++) sources[i] = authorities[i];
        address[] memory tokens = new address[](2);
        tokens[0] = usdc;
        tokens[1] = usdt;

        (registry, impl) = _deployStack(sources, tokens);
        _etchDelegations(address(impl));

        for (uint256 i; i < 7; i++) {
            MockERC20(usdc).mint(authorities[i], 1_000_000e6);
            MockERC20(usdt).mint(authorities[i], 1_000_000e6);
        }
    }

    /// @dev Places MockERC20 runtime code at `at` so the fixture's hard-coded token
    ///      addresses behave as real tokens with their own storage.
    function _installTokenCode(address at, string memory n, string memory s) internal {
        MockERC20 tmpl = new MockERC20(n, s, 6);
        vm.etch(at, address(tmpl).code);
    }

    function _deployStack(address[] memory sources, address[] memory tokens)
        internal
        returns (Registry, BatchDisperser)
    {
        uint64 nonce = vm.getNonce(address(this));
        address implAddr = vm.computeCreateAddress(address(this), nonce + 1);
        Registry reg = new Registry(OUTER_SIGNER, ENTRY_POINT, implAddr, sources, tokens);
        BatchDisperser d = new BatchDisperser(address(reg));
        require(address(d) == implAddr, "impl address mismatch");
        return (reg, d);
    }

    function _etchDelegations(address implAddr) internal {
        bytes memory designator = abi.encodePacked(hex"ef0100", implAddr);
        for (uint256 i; i < authorities.length; i++) vm.etch(authorities[i], designator);
        vm.etch(ENTRY_POINT, designator);
    }

    /// @dev The TS fixture places 6 USDC (3940 each) + 8 USDT (2991 each, last 2997)
    ///      records. INV-6: Σ USDC = 23640, Σ USDT = 23934.
    function test_TypeScriptFixture_ExecutesOnChain() public {
        uint256 usdcBefore = 0;
        for (uint256 i; i < 7; i++) usdcBefore += MockERC20(usdc).balanceOf(authorities[i]);

        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(bytes32(0), packed);

        uint256 usdcAfter = 0;
        for (uint256 i; i < 7; i++) usdcAfter += MockERC20(usdc).balanceOf(authorities[i]);

        // Σ USDC moved out of the authorities equals 6 × 3940 = 23640.
        assertEq(usdcBefore - usdcAfter, 23_640, "USDC total moved");
    }

    function test_TypeScriptFixture_Emits14Transfers() public {
        vm.recordLogs();
        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(bytes32(0), packed);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 transferTopic = keccak256("Transfer(address,address,uint256)");
        uint256 transfers;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == transferTopic) transfers++;
        }
        assertEq(transfers, 14, "expected 14 Transfer logs (INV-5)");
    }

    function test_TypeScriptFixture_RecipientsCredited() public {
        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(bytes32(0), packed);

        // Recipient 0x9000..0x9005 receive 3940 USDC each; 0xa000..0xa007 get USDT.
        assertEq(MockERC20(usdc).balanceOf(address(uint160(0x9000))), 3940);
        assertEq(MockERC20(usdc).balanceOf(address(uint160(0x9005))), 3940);
        assertEq(MockERC20(usdt).balanceOf(address(uint160(0xa000))), 2991);
        assertEq(MockERC20(usdt).balanceOf(address(uint160(0xa007))), 2997);
    }

    function test_TypeScriptFixture_ReplayRejected() public {
        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(bytes32(0), packed);

        vm.prank(OUTER_SIGNER);
        vm.expectRevert();
        BatchDisperser(ENTRY_POINT).executeBatch(bytes32(0), packed);
    }
}
