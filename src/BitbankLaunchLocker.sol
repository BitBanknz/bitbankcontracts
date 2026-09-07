// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPonsLaunchFactory, INonfungiblePositionManagerLike} from "./vendor/pons-v1/interfaces/ILaunchpad.sol";

/// @notice Permanent V3 NFT custody. Collected pool fees and sniper fees split 10% protocol / 90% creator side.
/// @dev With a 1% pool fee that is 10 / 90 basis points of fee-bearing volume. No withdrawal, approval,
/// liquidity decrease, upgrade, or arbitrary call exists. All payouts are pull-based to recorded recipients.
contract BitbankLaunchLocker is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Four storage slots; public getter order is relied on by clients (recipient at index 4).
    struct Position { address manager; uint96 id; address token0; address token1; address recipient; bool exists; bool redirected; }

    address public immutable protocolFeeRecipient;
    address public factory;
    mapping(address => Position) public positions;
    /// @notice launch token => fee asset => cumulative fees routed through the locker.
    mapping(address => mapping(address => uint256)) public collected;
    /// @notice recipient => asset => claimable.
    mapping(address => mapping(address => uint256)) public credit;
    /// @notice asset => total credited and not yet claimed; balance above this is unaccounted sniper fees.
    mapping(address => uint256) public owed;

    event FactoryBound(address indexed factory);
    event PositionLocked(address indexed token, address manager, uint256 positionId, address recipient);
    event FeeRecipientSet(address indexed token, address recipient);
    event FeesCollected(address indexed token, address indexed asset, uint256 amount, uint256 protocolAmount);
    event FeesClaimed(address indexed recipient, address indexed asset, uint256 amount);

    error Unauthorized();
    error InvalidPosition();
    error NothingToClaim();

    constructor(address owner, address treasury) Ownable(owner) {
        if (treasury == address(0)) revert Unauthorized();
        protocolFeeRecipient = treasury;
    }
    function bindFactory(address factory_) external onlyOwner {
        if (factory != address(0) || factory_.code.length == 0) revert Unauthorized();
        factory = factory_;
        emit FactoryBound(factory_);
    }
    function onERC721Received(address operator, address from, uint256, bytes calldata) external view returns (bytes4) {
        address f = factory;
        if (f == address(0) || operator != f || from != f) revert Unauthorized();
        return this.onERC721Received.selector;
    }
    function lockPosition(address token) external {
        if (msg.sender != factory || positions[token].exists) revert Unauthorized();
        IPonsLaunchFactory.LaunchedToken memory r = IPonsLaunchFactory(factory).getLaunchedToken(token);
        if (
            !r.exists || r.token != token || r.poolFee != 10_000 || r.positionId > type(uint96).max
                || INonfungiblePositionManagerLike(r.positionManager).ownerOf(r.positionId) != address(this)
        ) revert InvalidPosition();
        (address a, address b) = r.isToken0 ? (token, r.pairedToken) : (r.pairedToken, token);
        positions[token] = Position(r.positionManager, uint96(r.positionId), a, b, r.deployer, true, false);
        emit PositionLocked(token, r.positionManager, r.positionId, r.deployer);
    }
    /// @dev Called once by the factory inside the launch transaction. No later redirect path exists.
    function setFeeRedirect(address token, address recipient) external {
        Position storage p = positions[token];
        if (msg.sender != factory || !p.exists || p.redirected || recipient == address(0)) revert Unauthorized();
        p.recipient = recipient;
        p.redirected = true;
        emit FeeRecipientSet(token, recipient);
    }
    /// @notice Permissionless: pulls accrued pool fees and credits the split.
    function collect(address token) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Position storage p = positions[token];
        if (!p.exists) revert InvalidPosition();
        (amount0, amount1) = INonfungiblePositionManagerLike(p.manager).collect(
            INonfungiblePositionManagerLike.CollectParams(p.id, address(this), type(uint128).max, type(uint128).max)
        );
        address recipient = p.recipient;
        if (amount0 != 0) _allocate(token, p.token0, recipient, amount0);
        if (amount1 != 0) _allocate(token, p.token1, recipient, amount1);
    }
    /// @notice Permissionless: credits sniper fees (or donations) of the launch token held by the locker.
    function sync(address token) external nonReentrant returns (uint256 amount) {
        Position storage p = positions[token];
        if (!p.exists) revert InvalidPosition();
        amount = IERC20(token).balanceOf(address(this)) - owed[token];
        if (amount == 0) revert NothingToClaim();
        _allocate(token, token, p.recipient, amount);
    }
    function _allocate(address token, address asset, address recipient, uint256 amount) private {
        uint256 before = collected[token][asset];
        uint256 total = before + amount;
        collected[token][asset] = total;
        // Cumulative rounding: collection frequency never changes the protocol share.
        uint256 protocolAmount = total / 10 - before / 10;
        credit[protocolFeeRecipient][asset] += protocolAmount;
        credit[recipient][asset] += amount - protocolAmount;
        owed[asset] += amount;
        emit FeesCollected(token, asset, amount, protocolAmount);
    }
    /// @notice Permissionless trigger; funds only ever go to the recorded recipient.
    function claim(address asset, address recipient) external nonReentrant returns (uint256 amount) {
        amount = credit[recipient][asset];
        if (amount == 0) revert NothingToClaim();
        credit[recipient][asset] = 0;
        owed[asset] -= amount;
        IERC20(asset).safeTransfer(recipient, amount);
        emit FeesClaimed(recipient, asset, amount);
    }
}
