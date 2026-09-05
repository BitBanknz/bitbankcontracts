// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPonsLaunchFactory, INonfungiblePositionManagerLike} from "./vendor/pons-v1/interfaces/ILaunchpad.sol";

/// @notice Permanent V3 NFT custody, 10% protocol / 90% collaborator split of collected pool fees.
/// @dev With a 1% pool fee, these equal 10 / 90 basis points of fee-bearing volume.
/// No position withdrawal, approval, liquidity decrease, upgrade, or arbitrary call exists.
contract BitbankLaunchLocker is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable protocolFeeRecipient;
    address public factory;
    struct Position { address manager; uint256 id; address token0; address token1; address recipient; bool exists; bool redirected; }
    mapping(address => Position) public positions;
    mapping(address => mapping(address => uint256)) public collected; // launch token => fee asset => cumulative fees
    mapping(address => mapping(address => uint256)) public credit; // recipient => asset => claimable
    event FactoryBound(address indexed factory);
    event PositionLocked(address indexed token, address manager, uint256 positionId, address recipient);
    event FeeRecipientSet(address indexed token, address recipient);
    event FeesCollected(address indexed token, address indexed asset, uint256 amount, uint256 protocolAmount);
    event FeesClaimed(address indexed recipient, address indexed asset, uint256 amount);
    error Unauthorized(); error InvalidPosition(); error NothingToClaim();

    constructor(address owner, address treasury) Ownable(owner) {
        if (treasury == address(0)) revert Unauthorized(); protocolFeeRecipient = treasury;
    }
    function bindFactory(address factory_) external onlyOwner {
        if (factory != address(0) || factory_.code.length == 0) revert Unauthorized();
        factory = factory_; emit FactoryBound(factory_);
    }
    function onERC721Received(address operator, address from, uint256, bytes calldata) external view returns (bytes4) {
        if (factory == address(0) || operator != factory || from != factory) revert Unauthorized();
        return this.onERC721Received.selector;
    }
    function lockPosition(address token) external {
        if (msg.sender != factory || positions[token].exists) revert Unauthorized();
        IPonsLaunchFactory.LaunchedToken memory record = IPonsLaunchFactory(factory).getLaunchedToken(token);
        if (!record.exists || record.token != token || record.poolFee != 10_000 || INonfungiblePositionManagerLike(record.positionManager).ownerOf(record.positionId) != address(this)) revert InvalidPosition();
        address a = record.isToken0 ? token : record.pairedToken;
        address b = record.isToken0 ? record.pairedToken : token;
        positions[token] = Position(record.positionManager, record.positionId, a, b, record.deployer, true, false);
        emit PositionLocked(token, record.positionManager, record.positionId, record.deployer);
    }
    /// @dev The V1 factory calls this once, atomically during launch. No creator/admin redirect path exists.
    function setFeeRedirect(address token, address recipient) external {
        Position storage p = positions[token];
        if (msg.sender != factory || !p.exists || p.redirected || recipient == address(0)) revert Unauthorized();
        p.recipient = recipient; p.redirected = true; emit FeeRecipientSet(token, recipient);
    }
    function collect(address token) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Position storage p = positions[token]; if (!p.exists) revert InvalidPosition();
        (amount0, amount1) = INonfungiblePositionManagerLike(p.manager).collect(INonfungiblePositionManagerLike.CollectParams(p.id,address(this),type(uint128).max,type(uint128).max));
        _allocate(token, p.token0, p.recipient, amount0); _allocate(token, p.token1, p.recipient, amount1);
    }
    function _allocate(address token, address asset, address recipient, uint256 amount) private {
        uint256 beforeTotal = collected[token][asset];
        uint256 afterTotal = beforeTotal + amount; collected[token][asset] = afterTotal;
        // Cumulative rounding makes collection frequency irrelevant to the protocol share.
        uint256 protocolAmount = Math.mulDiv(afterTotal, 1000, 10_000) - Math.mulDiv(beforeTotal, 1000, 10_000);
        credit[protocolFeeRecipient][asset] += protocolAmount; credit[recipient][asset] += amount - protocolAmount;
        emit FeesCollected(token, asset, amount, protocolAmount);
    }
    /// @notice Permissionless trigger; the recipient is fixed, never msg.sender by inference.
    function claim(address asset, address recipient) external nonReentrant returns (uint256 amount) {
        amount = credit[recipient][asset]; if (amount == 0) revert NothingToClaim();
        credit[recipient][asset] = 0; IERC20(asset).safeTransfer(recipient, amount);
        emit FeesClaimed(recipient, asset, amount);
    }
}
