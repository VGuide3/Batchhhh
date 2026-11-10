// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IRegistry
/// @notice Read-only registry the implementation consults for its source and token
///         allowlists.
///
///         Why a separate contract instead of impl storage: under EIP-7702, delegated
///         code executes in the *delegating account's* context and therefore reads the
///         delegating account's storage. A registry held in the impl's own storage
///         would be invisible in both root mode (context = entry point) and leaf mode
///         (context = authority). Storing it behind an immutable address makes it
///         context-independent.
interface IRegistry {
    function outerSigner() external view returns (address);
    function entryPoint() external view returns (address);
    function delegationTarget() external view returns (address);
    function isRegisteredSource(address source) external view returns (bool);
    function isAllowedToken(address token) external view returns (bool);
    function sourceCount() external view returns (uint256);
    function sourceAt(uint256 ordinal) external view returns (address);
}
