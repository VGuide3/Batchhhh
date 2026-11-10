// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IEIP7702BatchDisperser} from "./interfaces/IEIP7702BatchDisperser.sol";
import {IRegistry} from "./interfaces/IRegistry.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";

/// @title BatchDisperser
/// @notice Shared EIP-7702 delegation implementation for SPEC-7702-BATCH-001.
///
///         Execution model
///         ----------------
///         A type-4 transaction executes only in `tx.to`'s context. The root call
///         therefore cannot debit other authorities directly. Instead `executeBatch`
///         iterates source ordinals and issues `CALL` to each source. Because a
///         delegated authority's code is `0xef0100 ‖ impl`, that CALL re-enters this
///         implementation *in the authority's own context*, where `address(this)` is
///         the authority and `SafeERC20.safeTransfer` debits the correct account. One
///         implementation, two modes, zero per-authority deploys.
///
///         Storage caveat (why the registry is a separate contract)
///         --------------------------------------------------------
///         Under EIP-7702 the delegated code reads the *delegating account's* storage.
///         In root mode that account is the entry point; in leaf mode it is an
///         authority. Neither holds this implementation's constructor state, so the
///         registry cannot live in impl storage — it is a separate immutable contract
///         (`IRegistry`) referenced through `registry`. The one piece of state the
///         implementation *does* keep is the replay guard, which is only ever touched
///         in root mode and therefore always resolves against the entry point's
///         storage consistently.
///
///         Packed batch layout (authoritative; total = 36 + 80*recordCount bytes)
///         ------------------------------------------------------------------------
///           offset  len  field
///           0x000     4  selector 0xa9059cbb (entry magic; matches transfer(address,uint256))
///           0x004     1  version = 0x01
///           0x005     1  flags  (bit0 allowPartial, bit1 sweepMode)
///           0x006     2  sourceCount (u16 BE)
///           0x008     4  recordCount (u32 BE)
///           0x00C    24  batchId (bytes24)
///           0x024  80*N  records: token[20] ‖ to[20] ‖ amount[32] ‖ tag[8]
///
///         For a 14-record batch: 36 + 14*80 = 1156 bytes. The source spec's offset
///         table lists batchId as 20 bytes (yielding 1152) while simultaneously
///         asserting `4 + 32 + 80*N` and requiring 1156; this uses a 24-byte batchId,
///         matching the `BatchIdReplay(bytes24)` error and the interface struct.
///
///         Immutability / security posture
///         -------------------------------
///         No owner, no proxy, no delegatecall, no approve, no arbitrary sweep.
contract BatchDisperser is IEIP7702BatchDisperser {
    using SafeERC20 for IERC20;

    /// @dev 0xef0100 ‖ impl — the EIP-7702 delegation designator prefix.
    bytes3 internal constant DELEGATION_PREFIX = 0xef0100;

    /// @dev Entry magic; deliberately equals the `transfer(address,uint256)` selector.
    bytes4 internal constant ENTRY_MAGIC = 0xa9059cbb;

    uint8 internal constant VERSION = 0x01;
    uint8 internal constant FLAG_ALLOW_PARTIAL = 0x01;
    uint8 internal constant FLAG_SWEEP_MODE = 0x02;

    /// @dev Per-source record ceiling. Reference batch peaks at 2/source; 8 leaves
    ///      headroom inside the 30M block gas ceiling.
    uint256 public constant MAX_RECORDS_PER_SOURCE = 8;

    /// @notice Immutable registry consulted for allowlists and identities.
    IRegistry public immutable registry;

    /// @notice EOA that pays gas and authorizes the root call. No delegation.
    address public immutable outerSigner;
    /// @notice `tx.to` — the root execution context.
    address public immutable entryPoint;
    /// @notice The shared delegation target (this contract) recorded in the registry.
    address public immutable delegationTarget;

    /// @dev Replay guard keyed on batchId. Only written in root mode, so it always
    ///      resolves against the entry point's storage.
    mapping(bytes24 => bool) internal executed;

    constructor(address registry_) {
        require(registry_ != address(0), "registry=0");
        registry = IRegistry(registry_);
        outerSigner = IRegistry(registry_).outerSigner();
        entryPoint = IRegistry(registry_).entryPoint();
        delegationTarget = IRegistry(registry_).delegationTarget();
    }

    // ---------------------------------------------------------------------
    // Registry views (consumed by the off-chain reconciler)
    // ---------------------------------------------------------------------

    function isRegisteredSource(address source) public view returns (bool) {
        return registry.isRegisteredSource(source);
    }

    function isAllowedToken(address token) public view returns (bool) {
        return registry.isAllowedToken(token);
    }

    function sourceCount() external view returns (uint256) {
        return registry.sourceCount();
    }

    function sourceAt(uint256 ordinal) public view returns (address) {
        return registry.sourceAt(ordinal);
    }

    // ---------------------------------------------------------------------
    // Root mode
    // ---------------------------------------------------------------------

    /// @inheritdoc IEIP7702BatchDisperser
    function executeBatch(bytes32 salt, bytes calldata packed) external {
        // A relayer (any msg.sender != outerSigner) appends a 65-byte signature to
        // the payload; the signature covers the payload *without* the appended bytes.
        bytes calldata payload = _authorize(salt, packed);

        (Header memory h, Record[] memory recs) = _decode(payload);
        if (executed[h.batchId]) revert BatchIdReplay(h.batchId);
        executed[h.batchId] = true;

        for (uint16 s; s < h.sourceCount; ++s) {
            address src = sourceAt(s);
            if (!isRegisteredSource(src)) revert UnknownSource(s);
            if (!_isDelegated(src)) revert SourceNotDelegated(src);

            Record[] memory slice = _filter(recs, s);
            if (slice.length == 0) continue;

            (bool ok, bytes memory ret) =
                src.call(abi.encodeCall(IEIP7702BatchDisperser.executeLeaf, (salt, slice)));
            if (!ok) _bubble(ret);
        }

        emit BatchExecuted(h.batchId, h.recordCount, h.sourceCount);
    }

    // ---------------------------------------------------------------------
    // Leaf mode
    // ---------------------------------------------------------------------

    /// @inheritdoc IEIP7702BatchDisperser
    function executeLeaf(bytes32 /* salt */, Record[] calldata records) external {
        if (!isRegisteredSource(msg.sender)) revert NotRoot();
        if (records.length > MAX_RECORDS_PER_SOURCE) revert RecordCapExceeded();

        for (uint256 i; i < records.length; ++i) {
            Record calldata r = records[i];
            if (!isAllowedToken(r.token)) {
                revert TransferFailed(r.token, r.to, r.amount);
            }
            // transfer (not transferFrom): this runs in the source's own context.
            IERC20(r.token).safeTransfer(r.to, r.amount);
        }
    }

    // ---------------------------------------------------------------------
    // Decoding
    // ---------------------------------------------------------------------

    /// @dev Decodes and validates the packed payload. Reverts on version mismatch
    ///      and on any length deviation from `36 + 80 * recordCount`.
    function _decode(bytes calldata packed)
        internal
        pure
        returns (Header memory h, Record[] memory recs)
    {
        // Fixed prefix: selector(4) + version(1) + flags(1) + sourceCount(2)
        //               + recordCount(4) + batchId(24) = 36 bytes.
        if (packed.length < 36) revert LengthMismatch();
        if (bytes4(packed[0:4]) != ENTRY_MAGIC) revert LengthMismatch();

        h.version = uint8(packed[4]);
        if (h.version != VERSION) revert BadVersion();
        h.flags = uint8(packed[5]);
        h.sourceCount = _u16(packed[6:8]);
        h.recordCount = _u32(packed[8:12]);
        h.batchId = bytes24(packed[12:36]);

        if (packed.length != 36 + 80 * uint256(h.recordCount)) revert LengthMismatch();

        recs = new Record[](h.recordCount);
        for (uint256 i; i < h.recordCount; ++i) {
            uint256 base = 36 + i * 80;
            recs[i] = Record({
                token: address(bytes20(packed[base:base + 20])),
                to: address(bytes20(packed[base + 20:base + 40])),
                amount: uint256(bytes32(packed[base + 40:base + 72])),
                tag: bytes8(packed[base + 72:base + 80])
            });
        }
    }

    /// @dev Returns records whose tag[0:2] (u16 BE) equals `ordinal`.
    function _filter(Record[] memory recs, uint16 ordinal)
        internal
        pure
        returns (Record[] memory out)
    {
        uint256 n;
        for (uint256 i; i < recs.length; ++i) {
            if (_ordinal(recs[i].tag) == ordinal) ++n;
        }
        out = new Record[](n);
        uint256 j;
        for (uint256 i; i < recs.length; ++i) {
            if (_ordinal(recs[i].tag) == ordinal) {
                out[j] = recs[i];
                ++j;
            }
        }
    }

    function _ordinal(bytes8 tag) internal pure returns (uint16) {
        return uint16(bytes2(tag));
    }

    /// @dev True if `account` carries an EIP-7702 designator pointing at
    ///      `delegationTarget`. NOTE: when this code runs *in* a delegated context
    ///      (root mode via the entry point) `address(this)` is the delegating
    ///      account, so the stored `delegationTarget` immutable is the reference.
    function _isDelegated(address account) internal view returns (bool) {
        bytes memory code = account.code;
        if (code.length < 23) return false;
        if (bytes3(code) != DELEGATION_PREFIX) return false;
        uint160 target;
        for (uint256 i = 3; i < 23; ++i) {
            target = (target << 8) | uint8(code[i]);
        }
        return address(target) == delegationTarget;
    }

    function _u16(bytes calldata b) internal pure returns (uint16) {
        return (uint16(uint8(b[0])) << 8) | uint16(uint8(b[1]));
    }

    function _u32(bytes calldata b) internal pure returns (uint32) {
        return (uint32(uint8(b[0])) << 24) | (uint32(uint8(b[1])) << 16)
            | (uint32(uint8(b[2])) << 8) | uint32(uint8(b[3]));
    }

    // ---------------------------------------------------------------------
    // Signature verification (relayer path)
    // ---------------------------------------------------------------------

    /// @dev Authorizes the root call and returns the payload slice to decode.
    ///      If `msg.sender` is the outer signer, `packed` is the payload verbatim.
    ///      Otherwise `packed` must be `payload ‖ r ‖ s ‖ v` and the 65-byte tail is
    ///      stripped and verified against `keccak256(salt ‖ payload)`.
    function _authorize(bytes32 salt, bytes calldata packed)
        internal
        view
        returns (bytes calldata payload)
    {
        if (msg.sender == outerSigner) return packed;
        if (packed.length < 36 + 65) revert NotRoot();

        payload = packed[:packed.length - 65];
        if (!_validSig(salt, payload, packed[packed.length - 65:])) revert NotRoot();
    }

    /// @dev Recovers the signer of `keccak256(salt ‖ payload)` and compares to the
    ///      outer signer. Enforces low-`s` and `v ∈ {27,28}` against malleability.
    function _validSig(bytes32 salt, bytes calldata payload, bytes calldata sig)
        internal
        view
        returns (bool)
    {
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v != 27 && v != 28) return false;
        // Enforce low-s (EIP-2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return false;
        }
        address recovered = ecrecover(keccak256(abi.encodePacked(salt, payload)), v, r, s);
        return recovered != address(0) && recovered == outerSigner;
    }

    // ---------------------------------------------------------------------
    // Error bubbling
    // ---------------------------------------------------------------------

    function _bubble(bytes memory ret) internal pure {
        if (ret.length == 0) revert TransferFailed(address(0), address(0), 0);
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
