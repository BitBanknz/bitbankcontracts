// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC20PermitLike {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/// @notice FlexGas-style network fee top-up. A wallet holding only USDC/USDT signs an EIP-712 quote (and an
/// ERC-2612 permit when the token supports it); the Bitbank relayer submits it and this contract atomically
/// pulls the exact token amount and sends the exact ETH amount to the user, who then pays gas normally.
/// @dev The user never trusts the relayer with amounts: both amounts, the token and the deadline are covered by
/// the user's own signature, and a quote id can be consumed once. Only EOAs (ecrecover) are supported.
contract BitbankGasStation is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant TOPUP_TYPEHASH = keccak256("TopUp(address user,address token,uint256 tokenAmount,uint256 ethAmount,uint256 deadline,bytes32 quoteId)");
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    struct TopUp { address user; address token; uint256 tokenAmount; uint256 ethAmount; uint256 deadline; bytes32 quoteId; }
    struct Permit { uint256 deadline; uint8 v; bytes32 r; bytes32 s; }
    address public relayer;
    uint256 public maxEthPerTopUp;
    mapping(address => bool) public acceptedTokens;
    mapping(bytes32 => bool) public consumed;
    event RelayerSet(address relayer);
    event TokenAccepted(address indexed token, bool accepted);
    event MaxEthPerTopUpSet(uint256 amount);
    event ToppedUp(address indexed user, address indexed token, uint256 tokenAmount, uint256 ethAmount, bytes32 indexed quoteId);
    event Withdrawn(address indexed asset, address indexed to, uint256 amount);
    error Unauthorized(); error Expired(); error QuoteConsumed(); error TokenNotAccepted(); error InvalidSignature(); error EthTransferFailed(); error InvalidAmount();

    constructor(address owner, address relayer_, uint256 maxEth) Ownable(owner) {
        if (relayer_ == address(0) || maxEth == 0) revert InvalidAmount();
        relayer = relayer_; maxEthPerTopUp = maxEth;
    }
    receive() external payable {}
    function setRelayer(address relayer_) external onlyOwner { if (relayer_ == address(0)) revert Unauthorized(); relayer = relayer_; emit RelayerSet(relayer_); }
    function setAcceptedToken(address token, bool accepted) external onlyOwner { if (token == address(0)) revert TokenNotAccepted(); acceptedTokens[token] = accepted; emit TokenAccepted(token, accepted); }
    function setMaxEthPerTopUp(uint256 amount) external onlyOwner { if (amount == 0) revert InvalidAmount(); maxEthPerTopUp = amount; emit MaxEthPerTopUpSet(amount); }
    /// @notice Owner sweeps collected fee tokens or unused ETH float. asset == address(0) means ETH.
    function withdraw(address asset, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert Unauthorized();
        if (asset == address(0)) { (bool ok,) = to.call{value: amount}(""); if (!ok) revert EthTransferFailed(); }
        else IERC20(asset).safeTransfer(to, amount);
        emit Withdrawn(asset, to, amount);
    }
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("BitbankGasStation"), keccak256("1"), block.chainid, address(this)));
    }
    function hashTopUp(TopUp calldata t) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(TOPUP_TYPEHASH, t.user, t.token, t.tokenAmount, t.ethAmount, t.deadline, t.quoteId))));
    }
    /// @notice Relayer-only. `permit.deadline == 0` skips the permit and relies on an existing allowance.
    /// A front-run permit is harmless: the allowance already exists, so the pull still succeeds.
    function topUp(TopUp calldata t, bytes calldata userSignature, Permit calldata permit) external nonReentrant {
        if (msg.sender != relayer) revert Unauthorized();
        if (block.timestamp > t.deadline) revert Expired();
        if (consumed[t.quoteId]) revert QuoteConsumed();
        if (!acceptedTokens[t.token]) revert TokenNotAccepted();
        if (t.ethAmount == 0 || t.ethAmount > maxEthPerTopUp || t.tokenAmount == 0) revert InvalidAmount();
        if (_recover(hashTopUp(t), userSignature) != t.user) revert InvalidSignature();
        consumed[t.quoteId] = true;
        if (permit.deadline != 0) {
            try IERC20PermitLike(t.token).permit(t.user, address(this), t.tokenAmount, permit.deadline, permit.v, permit.r, permit.s) {} catch {}
        }
        IERC20(t.token).safeTransferFrom(t.user, address(this), t.tokenAmount);
        (bool ok,) = t.user.call{value: t.ethAmount}("");
        if (!ok) revert EthTransferFailed();
        emit ToppedUp(t.user, t.token, t.tokenAmount, t.ethAmount, t.quoteId);
    }
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]); bytes32 s = bytes32(signature[32:64]); uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_ORDER) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
