// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IEIP7702BatchDisperser
/// @notice Interface for the shared EIP-7702 delegation implementation used by
///         SPEC-7702-BATCH-001. One implementation serves N delegated authorities
///         and is entered in two modes:
///           - root mode (`executeBatch`): runs in the entry point's context and
///             dispatches one CALL per source.
///           - leaf mode (`executeLeaf`): runs in an authority's own context and
///             performs the actual ERC-20 transfers.
interface IEIP7702BatchDisperser {
    /// @dev A single dispersal record. Layout is fixed for the packed batch encoding:
    ///      token[20] ‖ to[20] ‖ amount[32] ‖ tag[8] = 80 bytes.
    struct Record {
        address token; // 20 bytes — must be allowlisted
        address to; // 20 bytes — recipient, must be non-zero and != source
        uint256 amount; // 32 bytes — base units
        bytes8 tag; // 8 bytes — tag[0:2] = source ordinal (u16 BE), tag[2:8] reserved
    }

    /// @dev Decoded header of a packed batch.
    ///      Offsets: selector[4] ‖ version[1] ‖ flags[1] ‖ sourceCount[2] ‖
    ///      recordCount[4] ‖ batchId[20] ‖ records[80*N].
    struct Header {
        uint8 version;
        uint8 flags;
        uint16 sourceCount;
        uint32 recordCount;
        bytes24 batchId;
    }

    /// @notice Caller is neither the outer signer nor a valid relayer signature.
    error NotRoot();
    /// @notice Packed payload version byte is not supported.
    error BadVersion();
    /// @notice `packed.length` does not equal `4 + 32 + 80 * recordCount`.
    error LengthMismatch();
    /// @notice A source ordinal in the batch is not registered.
    error UnknownSource(uint16 ordinal);
    /// @notice A registered source has no EIP-7702 delegation designator.
    error SourceNotDelegated(address source);
    /// @notice A transfer failed (or token not allowlisted).
    error TransferFailed(address token, address to, uint256 amount);
    /// @notice The batchId has already been executed.
    error BatchIdReplay(bytes24 batchId);
    /// @notice A source slice exceeded MAX_RECORDS_PER_SOURCE.
    error RecordCapExceeded();

    /// @notice Emitted once per successful root execution.
    event BatchExecuted(bytes24 indexed batchId, uint32 recordCount, uint16 sourceCount);

    /// @notice Root mode. `msg.sender` must be the outer signer, or the caller must
    ///         supply a signature over `keccak256(salt ‖ packed)` that recovers to it.
    /// @param salt    Off-chain plan salt; with chainId + entryPoint it derives batchId.
    /// @param packed  Packed batch payload (see Header for the byte layout).
    function executeBatch(bytes32 salt, bytes calldata packed) external;

    /// @notice Leaf mode. Runs in the authority's context. Only reachable when
    ///         `msg.sender` is a registered source (the entry point during root dispatch).
    /// @param salt    Same salt as the enclosing root call.
    /// @param records The records attributed to `msg.sender`'s source ordinal.
    function executeLeaf(bytes32 salt, Record[] calldata records) external;
}
