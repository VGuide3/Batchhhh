// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal ERC-20 surface. Only the calls this implementation makes.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}
