// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BatchDisperser} from "../src/BatchDisperser.sol";
import {Registry} from "../src/Registry.sol";
import {IEIP7702BatchDisperser} from "../src/interfaces/IEIP7702BatchDisperser.sol";
import {MockERC20, NoReturnERC20, FalseReturnERC20} from "./mocks/MockERC20.sol";

/// @dev Unit tests for the delegation implementation.
///
///      Delegation semantics reproduced here: a type-4 tx runs only in `tx.to`'s
///      context. We therefore (a) etch `0xef0100 ‖ impl` onto the entry point so a
///      call to the entry point runs the impl's code in the entry point's context,
///      and (b) etch the same designator onto each authority so the root's CALL to
///      an authority re-enters the impl in the authority's own context.
///
///      Root entry: calling `EntryPoint.executeBatch(...)` executes impl code with
///      `msg.sender == OUTER_SIGNER` and `address(this) == ENTRY_POINT`.
contract BatchDisperserTest is Test {
    BatchDisperser internal impl;
    Registry internal registry;
    MockERC20 internal usdc;
    MockERC20 internal usdt;

    address internal constant OUTER_SIGNER = address(0xA11CE);
    address internal constant ENTRY_POINT = address(0xEBBA);

    address[] internal authorities;
    address internal constant APPROVED_SOURCE = address(0xACCE);

    uint8 internal constant VERSION = 0x01;
    bytes4 internal constant MAGIC = 0xa9059cbb;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdt = new MockERC20("Tether", "USDT", 6);

        for (uint160 i = 1; i <= 7; i++) {
            authorities.push(address(uint160(0x1000 + i)));
        }

        address[] memory sources = new address[](8);
        for (uint256 i; i < 7; i++) sources[i] = authorities[i];
        sources[7] = APPROVED_SOURCE;

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(usdt);

        (registry, impl) = _deployStack(sources, tokens);
        _etchDelegations(address(impl));
    }

    /// @dev Deploys Registry + BatchDisperser with the impl address precomputed so the
    ///      registry can record it as the delegation target.
    function _deployStack(address[] memory sources, address[] memory tokens)
        internal
        returns (Registry, BatchDisperser)
    {
        // impl is deployed by `this` (CREATE) right after the registry.
        uint64 nonce = vm.getNonce(address(this));
        // registry occupies `nonce`; impl occupies `nonce + 1`.
        address implAddr = vm.computeCreateAddress(address(this), nonce + 1);
        Registry reg =
            new Registry(OUTER_SIGNER, ENTRY_POINT, implAddr, sources, tokens);
        BatchDisperser d = new BatchDisperser(address(reg));
        require(address(d) == implAddr, "impl address mismatch");
        return (reg, d);
    }

    function _etchDelegations(address implAddr) internal {
        bytes memory designator = abi.encodePacked(hex"ef0100", implAddr);
        for (uint256 i; i < 7; i++) vm.etch(authorities[i], designator);
        vm.etch(ENTRY_POINT, designator);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _tag(uint16 ordinal) internal pure returns (bytes8) {
        return bytes8(uint64(ordinal) << 48);
    }

    function _rec(address token, address to, uint256 amount, uint16 ordinal)
        internal
        pure
        returns (IEIP7702BatchDisperser.Record memory)
    {
        return
            IEIP7702BatchDisperser.Record({token: token, to: to, amount: amount, tag: _tag(ordinal)});
    }

    function _pack(
        uint8 version,
        uint8 flags,
        uint16 sourceCount,
        bytes24 batchId,
        IEIP7702BatchDisperser.Record[] memory recs
    ) internal pure returns (bytes memory out) {
        out = abi.encodePacked(MAGIC, version, flags, sourceCount, uint32(recs.length), batchId);
        for (uint256 i; i < recs.length; i++) {
            out = abi.encodePacked(out, recs[i].token, recs[i].to, recs[i].amount, recs[i].tag);
        }
    }

    /// @dev Reference shape: 14 records (USDC×6, USDT×8) across 7 authorities.
    function _referenceBatch(bytes24 batchId)
        internal
        view
        returns (bytes memory packed, IEIP7702BatchDisperser.Record[] memory recs)
    {
        recs = new IEIP7702BatchDisperser.Record[](14);
        for (uint16 i; i < 6; i++) {
            recs[i] = _rec(address(usdc), address(uint160(0x9000 + i)), 3940, i);
        }
        for (uint16 i; i < 8; i++) {
            recs[6 + i] = _rec(address(usdt), address(uint160(0xA000 + i)), 2991, i % 7);
        }
        packed = _pack(VERSION, 0, 7, batchId, recs);
    }

    function _fundAuthorities(uint256 usdcEach, uint256 usdtEach) internal {
        for (uint256 i; i < 7; i++) {
            usdc.mint(authorities[i], usdcEach);
            usdt.mint(authorities[i], usdtEach);
        }
    }

    // ------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------

    function test_ExecuteBatch_HappyPath() public {
        _fundAuthorities(100_000e6, 100_000e6);
        bytes32 salt = keccak256("plan-1");
        (bytes memory packed,) = _referenceBatch(bytes24(keccak256("batch-1")));
        assertEq(packed.length, 1156, "reference length must be 1156");

        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(salt, packed);

        assertEq(usdc.balanceOf(address(uint160(0x9000))), 3940);
        assertEq(usdt.balanceOf(address(uint160(0xA000))), 2991);
        assertEq(usdt.balanceOf(address(uint160(0xA007))), 2991);
    }

    function test_ExecuteBatch_EmitsBatchExecuted() public {
        _fundAuthorities(1_000_000e6, 1_000_000e6);
        bytes32 salt = keccak256("plan-emit");
        bytes24 batchId = bytes24(keccak256("batch-emit"));
        (bytes memory packed,) = _referenceBatch(batchId);

        vm.expectEmit(true, false, false, true, ENTRY_POINT);
        emit IEIP7702BatchDisperser.BatchExecuted(batchId, 14, 7);

        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(salt, packed);
    }

    /// @dev Raw entry path: the reference sends the packed payload as the whole
    ///      calldata (no `executeBatch` wrapper), so the 4-byte magic is the selector
    ///      and dispatch lands in `fallback`. Same outcome, exactly 1156 bytes.
    function test_RawEntry_FallbackPath_Executes() public {
        _fundAuthorities(100_000e6, 100_000e6);
        bytes24 batchId = bytes24(keccak256("batch-raw"));
        (bytes memory packed,) = _referenceBatch(batchId);

        vm.prank(OUTER_SIGNER);
        (bool ok,) = ENTRY_POINT.call(packed);
        assertTrue(ok, "raw fallback call must succeed");

        assertEq(usdc.balanceOf(address(uint160(0x9000))), 3940);
        assertEq(usdt.balanceOf(address(uint160(0xA007))), 2991);
    }

    function test_RawEntry_OnlyOuterSigner() public {
        _fundAuthorities(1e6, 1e6);
        (bytes memory packed,) = _referenceBatch(bytes24(keccak256("batch-raw2")));

        vm.prank(address(0xDEAD));
        (bool ok, bytes memory ret) = ENTRY_POINT.call(packed);
        assertFalse(ok, "raw entry must reject non-signer");
        assertEq(bytes4(ret), IEIP7702BatchDisperser.NotRoot.selector);
    }

    function test_RawEntry_ReplayRejected() public {
        _fundAuthorities(1e6, 1e6);
        bytes24 batchId = bytes24(keccak256("batch-raw3"));
        (bytes memory packed,) = _referenceBatch(batchId);

        vm.prank(OUTER_SIGNER);
        (bool ok,) = ENTRY_POINT.call(packed);
        assertTrue(ok);

        vm.prank(OUTER_SIGNER);
        (bool ok2,) = ENTRY_POINT.call(packed);
        assertFalse(ok2, "replay must revert");
    }

    // ------------------------------------------------------------------
    // Mode discrimination
    // ------------------------------------------------------------------

    function test_ExecuteBatch_NotRoot_UnregisteredCaller() public {
        _fundAuthorities(1e6, 1e6);
        (bytes memory packed,) = _referenceBatch(bytes24(keccak256("y")));

        vm.prank(address(0xDEAD));
        vm.expectRevert(IEIP7702BatchDisperser.NotRoot.selector);
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("x"), packed);
    }

    function test_ExecuteLeaf_FromUnregistered_Reverts() public {
        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(usdc), address(0xBEEF), 1, 0);

        // Calling the impl directly: msg.sender is this test contract, not registered.
        vm.expectRevert(IEIP7702BatchDisperser.NotRoot.selector);
        impl.executeLeaf(keccak256("s"), recs);
    }

    function test_ExecuteLeaf_FromEntryPoint_Succeeds() public {
        usdc.mint(authorities[0], 1000);
        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(usdc), address(0xBEEF), 1000, 0);

        // Simulate the root's CALL: target is the authority (so `address(this)` is the
        // authority, and the transfer debits it), while `msg.sender` is the entry
        // point, which is a registered source.
        vm.prank(ENTRY_POINT);
        BatchDisperser(authorities[0]).executeLeaf(keccak256("s"), recs);
        assertEq(usdc.balanceOf(address(0xBEEF)), 1000);
        assertEq(usdc.balanceOf(authorities[0]), 0);
    }

    function test_ExecuteLeaf_FromAuthorityViaDesignator_RevertsForUnregisteredCaller() public {
        usdc.mint(authorities[0], 1000);
        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(usdc), address(0xBEEF), 1000, 0);

        // Calling the etched authority runs impl code in its context; msg.sender is
        // this test contract, which is not a registered source → NotRoot.
        vm.expectRevert(IEIP7702BatchDisperser.NotRoot.selector);
        BatchDisperser(authorities[0]).executeLeaf(keccak256("s"), recs);
    }

    // ------------------------------------------------------------------
    // Decoder
    // ------------------------------------------------------------------

    function test_BadVersion() public {
        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(usdc), address(0xBEEF), 1, 0);
        bytes memory packed = _pack(0x02, 0, 1, bytes24(keccak256("b")), recs);

        vm.prank(OUTER_SIGNER);
        vm.expectRevert(IEIP7702BatchDisperser.BadVersion.selector);
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
    }

    function test_LengthMismatch_TooShort() public {
        bytes memory packed =
            abi.encodePacked(MAGIC, VERSION, uint8(0), uint16(1), uint32(1), bytes24(0));
        vm.prank(OUTER_SIGNER);
        vm.expectRevert(IEIP7702BatchDisperser.LengthMismatch.selector);
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
    }

    function test_LengthMismatch_OffByOne() public {
        bytes32 salt = keccak256("s");
        (bytes memory packed,) = _referenceBatch(bytes24(keccak256("b")));
        bytes memory truncated = new bytes(packed.length - 1);
        for (uint256 i; i < truncated.length; i++) truncated[i] = packed[i];

        vm.prank(OUTER_SIGNER);
        vm.expectRevert(IEIP7702BatchDisperser.LengthMismatch.selector);
        BatchDisperser(ENTRY_POINT).executeBatch(salt, truncated);
    }

    function test_BadMagic() public {
        bytes memory packed = abi.encodePacked(
            bytes4(0xdeadbeef), VERSION, uint8(0), uint16(0), uint32(0), bytes24(0)
        );
        vm.prank(OUTER_SIGNER);
        vm.expectRevert(IEIP7702BatchDisperser.LengthMismatch.selector);
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
    }

    // ------------------------------------------------------------------
    // Replay / allowlist / caps
    // ------------------------------------------------------------------

    function test_Replay() public {
        _fundAuthorities(1e6, 1e6);
        bytes32 salt = keccak256("s");
        bytes24 batchId = bytes24(keccak256("b"));
        (bytes memory packed,) = _referenceBatch(batchId);

        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(salt, packed);

        vm.prank(OUTER_SIGNER);
        vm.expectRevert(
            abi.encodeWithSelector(IEIP7702BatchDisperser.BatchIdReplay.selector, batchId)
        );
        BatchDisperser(ENTRY_POINT).executeBatch(salt, packed);
    }

    function test_Allowlist_RejectsNonAllowlistedToken() public {
        _fundAuthorities(1e6, 1e6);
        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        dai.mint(authorities[0], 1e18);

        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(dai), address(0xBEEF), 1e18, 0);
        bytes memory packed = _pack(VERSION, 0, 1, bytes24(keccak256("b")), recs);

        vm.prank(OUTER_SIGNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEIP7702BatchDisperser.TransferFailed.selector, address(dai), address(0xBEEF), 1e18
            )
        );
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
    }

    function test_RecordCapExceeded() public {
        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](9);
        for (uint256 i; i < 9; i++) {
            recs[i] = _rec(address(usdc), address(uint160(0xB000 + i)), 1, 0);
        }

        vm.prank(ENTRY_POINT);
        vm.expectRevert(IEIP7702BatchDisperser.RecordCapExceeded.selector);
        BatchDisperser(ENTRY_POINT).executeLeaf(keccak256("s"), recs);
    }

    function test_SourceNotDelegated() public {
        address fresh = address(0xF00D); // registered but has no code
        address[] memory sources = new address[](8);
        for (uint256 i; i < 7; i++) sources[i] = authorities[i];
        sources[7] = fresh;
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(usdt);
        (, BatchDisperser impl2) = _deployStack(sources, tokens);
        _etchDelegations(address(impl2));

        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(usdc), address(0xBEEF), 1, 7);
        bytes memory packed = _pack(VERSION, 0, 8, bytes24(keccak256("b")), recs);

        vm.prank(OUTER_SIGNER);
        vm.expectRevert(
            abi.encodeWithSelector(IEIP7702BatchDisperser.SourceNotDelegated.selector, fresh)
        );
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
    }

    // ------------------------------------------------------------------
    // Token return-value handling
    // ------------------------------------------------------------------

    function test_NoReturnToken_Succeeds() public {
        NoReturnERC20 t = new NoReturnERC20();
        t.mint(authorities[0], 500);

        address[] memory sources = new address[](8);
        for (uint256 i; i < 7; i++) sources[i] = authorities[i];
        sources[7] = APPROVED_SOURCE;
        address[] memory tokens = new address[](1);
        tokens[0] = address(t);
        (, BatchDisperser impl3) = _deployStack(sources, tokens);
        _etchDelegations(address(impl3));

        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(t), address(0xBEEF), 500, 0);
        bytes memory packed = _pack(VERSION, 0, 1, bytes24(keccak256("b")), recs);

        vm.prank(OUTER_SIGNER);
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
        assertEq(t.balanceOf(address(0xBEEF)), 500);
    }

    function test_FalseReturnToken_Reverts() public {
        FalseReturnERC20 t = new FalseReturnERC20();
        address[] memory sources = new address[](8);
        for (uint256 i; i < 7; i++) sources[i] = authorities[i];
        sources[7] = APPROVED_SOURCE;
        address[] memory tokens = new address[](1);
        tokens[0] = address(t);
        (, BatchDisperser impl4) = _deployStack(sources, tokens);
        _etchDelegations(address(impl4));

        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](1);
        recs[0] = _rec(address(t), address(0xBEEF), 1, 0);
        bytes memory packed = _pack(VERSION, 0, 1, bytes24(keccak256("b")), recs);

        vm.prank(OUTER_SIGNER);
        vm.expectRevert();
        BatchDisperser(ENTRY_POINT).executeBatch(keccak256("s"), packed);
    }

    // ------------------------------------------------------------------
    // Fuzz
    // ------------------------------------------------------------------

    function testFuzz_PackedLengthFormula(uint8 n) public view {
        n = uint8(bound(n, 1, 64));
        IEIP7702BatchDisperser.Record[] memory recs = new IEIP7702BatchDisperser.Record[](n);
        for (uint256 i; i < n; i++) {
            recs[i] = _rec(address(usdc), address(uint160(0x100 + i)), 1, 0);
        }
        bytes memory packed = _pack(VERSION, 0, 1, bytes24(0), recs);
        assertEq(packed.length, 36 + 80 * uint256(n));
    }
}
