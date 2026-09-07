// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Immutable collaborator allocation. Anyone can release; funds always go to the recorded wallet.
/// @dev Receives the 90% creator-side portion of locker credits. Standard ERC20 assets only; native ETH is
/// intentionally unsupported because V3 fees are ERC20 (WETH). Social handles are offchain labels only.
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
        uint256 n = wallets.length;
        if (n == 0 || n > 20 || n != allocation.length) revert InvalidRecipients();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address w = wallets[i];
            uint256 s = allocation[i];
            if (w == address(0) || shares[w] != 0 || s == 0 || s > BPS) revert InvalidRecipients();
            shares[w] = s;
            recipients.push(w);
            sum += s;
        }
        if (sum != BPS) revert InvalidRecipients();
    }
    function recipientCount() external view returns (uint256) { return recipients.length; }
    function claimable(address asset, address recipient) public view returns (uint256) {
        uint256 received = IERC20(asset).balanceOf(address(this)) + totalReleased[asset];
        return received * shares[recipient] / BPS - released[asset][recipient];
    }
    function release(address asset, address recipient) external nonReentrant returns (uint256 amount) {
        amount = claimable(asset, recipient);
        if (amount == 0) revert NothingToClaim();
        released[asset][recipient] += amount;
        totalReleased[asset] += amount;
        IERC20(asset).safeTransfer(recipient, amount);
        emit PaymentReleased(asset, recipient, amount);
    }
}
