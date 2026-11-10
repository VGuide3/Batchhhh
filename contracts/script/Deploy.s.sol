// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {BatchDisperser} from "../src/BatchDisperser.sol";
import {Registry} from "../src/Registry.sol";

/// @dev Deploys the Registry + BatchDisperser pair and prints the addresses to record
///      in the off-chain registry.
///
///      The impl address must be known before deploying the Registry (the Registry
///      stores it as `delegationTarget`), so this script predicts the impl address
///      from the deployer nonce exactly as the cross-language test does.
///
///      Usage:
///        forge script script/Deploy.s.sol \
///          --rpc-url $ETH_RPC_URL --broadcast \
///          --sig "run(address,address,address[],address[])" \
///          $OUTER_SIGNER $ENTRY_POINT '[...]' '[...]'
contract Deploy is Script {
    function run(
        address outerSigner,
        address entryPoint,
        address[] calldata authorities,
        address[] calldata tokens
    ) external returns (Registry registry, BatchDisperser impl) {
        require(authorities.length == 7, "authorities must be 7");
        require(tokens.length >= 1, "tokens empty");

        // impl is deployed by this script address immediately after the Registry.
        address implAddr = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        vm.startBroadcast();
        registry = new Registry(outerSigner, entryPoint, implAddr, authorities, tokens);
        impl = new BatchDisperser(address(registry));
        vm.stopBroadcast();

        require(address(impl) == implAddr, "impl address mismatch");

        console2.log("Registry        :", address(registry));
        console2.log("BatchDisperser  :", address(impl));
        console2.log("delegationTarget:", implAddr);
    }
}
