// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IRegistry} from "./interfaces/IRegistry.sol";

/// @title Registry
/// @notice Immutable, ownerless registry of the batch epoch: outer signer, entry point,
///         delegation target, source ordinals, and the token allowlist.
///
///         Deployed once per epoch and referenced by the implementation through an
///         immutable address, so it is readable from any execution context (root,
///         leaf, or plain `eth_call`) regardless of which account's storage is active.
contract Registry is IRegistry {
    address public immutable override outerSigner;
    address public immutable override entryPoint;
    address public immutable override delegationTarget;

    address[] internal sources; // ordinal → address
    mapping(address => bool) internal registeredSource;
    mapping(address => bool) internal allowedToken;

    /// @param outerSigner_      Gas-paying EOA, no delegation.
    /// @param entryPoint_       `tx.to`; the root execution context.
    /// @param delegationTarget_ The implementation address all authorities delegate to.
    /// @param sources_          Ordinal-ordered sources (authorities first, then approved).
    /// @param tokens_           Token allowlist.
    constructor(
        address outerSigner_,
        address entryPoint_,
        address delegationTarget_,
        address[] memory sources_,
        address[] memory tokens_
    ) {
        require(outerSigner_ != address(0), "outerSigner=0");
        require(entryPoint_ != address(0), "entryPoint=0");
        require(delegationTarget_ != address(0), "delegationTarget=0");
        require(sources_.length <= type(uint16).max, "too many sources");
        outerSigner = outerSigner_;
        entryPoint = entryPoint_;
        delegationTarget = delegationTarget_;

        // The entry point is a registered source in the leaf-mode sense: the root
        // reaches leaves by CALL from the entry point's context, so `msg.sender`
        // inside a leaf is the entry point (§5.2). It is not given an ordinal — the
        // ordinal space is reserved for the 7 authorities and the approved sources.
        registeredSource[entryPoint_] = true;

        for (uint256 i; i < sources_.length; ++i) {
            address s = sources_[i];
            require(s != address(0), "source=0");
            require(!registeredSource[s], "dup source");
            registeredSource[s] = true;
            sources.push(s);
        }
        for (uint256 i; i < tokens_.length; ++i) {
            address t = tokens_[i];
            require(t != address(0), "token=0");
            allowedToken[t] = true;
        }
    }

    function isRegisteredSource(address source) external view override returns (bool) {
        return registeredSource[source];
    }

    function isAllowedToken(address token) external view override returns (bool) {
        return allowedToken[token];
    }

    function sourceCount() external view override returns (uint256) {
        return sources.length;
    }

    function sourceAt(uint256 ordinal) external view override returns (address) {
        require(ordinal < sources.length, "ordinal oob");
        return sources[ordinal];
    }
}
