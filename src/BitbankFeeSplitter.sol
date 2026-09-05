// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Immutable collaborator allocation. Anyone can release; funds always go to the recorded wallet.
/// @dev Receives the 90% collaborator portion of collected LP fees. Supports standard ERC20 assets only.
/// Social handles are offchain labels and cannot authorize withdrawals. Native ETH is intentionally unsupported.
contract BitbankFeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant BPS = 10_000;
    address[] public recipients;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public totalReleased;
    mapping(address => mapping(address => uint256)) public released;
    event PaymentReleased(address indexed asset, address indexed recipient, uint256 amount);
    error InvalidRecipients();
    error NothingToClaim();

    constructor(address[] memory wallets, uint256[] memory allocation) {
        if (wallets.length == 0 || wallets.length > 20 || wallets.length != allocation.length) revert InvalidRecipients();
        uint256 sum;
        for (uint256 i; i < wallets.length; ++i) {
            if (wallets[i] == address(0) || shares[wallets[i]] != 0 || allocation[i] == 0 || allocation[i] > BPS) revert InvalidRecipients();
            shares[wallets[i]] = allocation[i]; recipients.push(wallets[i]); sum += allocation[i];
        }
        if (sum != BPS) revert InvalidRecipients();
    }
    function recipientCount() external view returns (uint256) { return recipients.length; }
    function claimable(address asset, address recipient) public view returns (uint256) {
        uint256 received = IERC20(asset).balanceOf(address(this)) + totalReleased[asset];
        return Math.mulDiv(received, shares[recipient], BPS) - released[asset][recipient];
    }
    function release(address asset, address recipient) external nonReentrant returns (uint256 amount) {
        amount = claimable(asset, recipient);
        if (amount == 0) revert NothingToClaim();
        released[asset][recipient] += amount; totalReleased[asset] += amount;
        IERC20(asset).safeTransfer(recipient, amount);
        emit PaymentReleased(asset, recipient, amount);
    }
}
