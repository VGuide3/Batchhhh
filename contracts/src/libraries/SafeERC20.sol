// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeERC20
/// @notice Minimal, self-contained ERC-20 transfer helper. USDT and similar tokens
///         do not return a bool, so a bare `transfer` must be tolerated when it
///         returns no data. A `false` return is always a failure.
library SafeERC20 {
    error SafeERC20FailedOperation(address token);

    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeCall(IERC20.transfer, (to, value))
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeERC20FailedOperation(address(token));
        }
    }
}
