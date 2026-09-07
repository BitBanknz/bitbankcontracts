// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Bitbank adaptation of the Pons Family V1 launch token (src/vendor/pons-v1/PonsLauncherToken.sol).
// Changes: cached canonical pool, decaying early-buy sniper fee paid to the locker, launch-block
// exemption keyed on the immutable deployer instead of a mutable recipient slot, smaller ABI.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IUniswapV3FactoryLike, IUniswapV3PoolImmutablesLike} from "./vendor/pons-v1/interfaces/ILaunchpad.sol";

/// @notice Fixed-supply ERC-20 deployed only by BitbankLaunchFactory via CREATE2.
/// @dev Pool-to-wallet buys are the only restricted transfers. Launch block: only the creator's
/// atomic initial buy. Following `restrictionBlocks`: per-wallet caps plus a sniper fee that
/// decays linearly to zero; fee tokens go to the locker and follow the normal 10/90 split.
contract BitbankLauncherToken is ERC20 {
    struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }

    error LaunchBlockBuyBlocked();
    error MaxWalletExceeded();
    error MaxTxExceeded();
    error NotLaunchFactory();
    error ZeroAddress();

    address public immutable deployer;
    address public immutable launchFactory;
    address public immutable dexFactory;
    address public immutable pairToken;
    address public immutable locker;
    uint24 public immutable poolFee;
    uint256 public immutable launchBlock;
    uint256 public immutable restrictionEndBlock;
    uint32 private immutable _restrictionBlocks;
    uint16 public immutable maxWalletBps;
    uint16 public immutable maxTxBps;
    /// @notice Sniper fee at launch, in bps of bought tokens; decays to zero at `restrictionEndBlock`.
    uint16 public immutable sniperFeeBps;
    /// @notice Canonical 1% pool, set once by the factory in the launch transaction.
    address public pool;
    /// @dev abi.encode(logo, description, Socials): one blob write at deploy, decoded by the views.
    bytes private _metadata;
    mapping(address => uint256) private _restrictedPoolBuys;

    constructor(
        string memory name_, string memory symbol_, bytes memory metadata_,
        address deployer_, address dexFactory_, address pairToken_, address locker_, uint24 poolFee_, uint256 supply_,
        uint16 maxWalletBps_, uint16 maxTxBps_, uint32 restrictionBlocks_, uint16 sniperFeeBps_
    ) ERC20(name_, symbol_) {
        if (deployer_ == address(0) || dexFactory_ == address(0) || pairToken_ == address(0) || locker_ == address(0)) revert ZeroAddress();
        deployer = deployer_; launchFactory = msg.sender; dexFactory = dexFactory_; pairToken = pairToken_; locker = locker_;
        poolFee = poolFee_; launchBlock = block.number; _restrictionBlocks = restrictionBlocks_;
        restrictionEndBlock = block.number + restrictionBlocks_;
        maxWalletBps = maxWalletBps_; maxTxBps = maxTxBps_; sniperFeeBps = sniperFeeBps_;
        _metadata = metadata_;
        _mint(msg.sender, supply_);
    }

    function setPool(address pool_) external {
        if (msg.sender != launchFactory || pool != address(0) || pool_ == address(0)) revert NotLaunchFactory();
        pool = pool_;
    }
    function liquidityPool() public view returns (address) {
        address p = pool;
        return p != address(0) ? p : IUniswapV3FactoryLike(dexFactory).getPool(address(this), pairToken, poolFee);
    }
    function metadata() public view returns (string memory logo_, string memory description_, Socials memory socials_) {
        return abi.decode(_metadata, (string, string, Socials));
    }
    function logo() external view returns (string memory l) { (l,,) = metadata(); }
    function description() external view returns (string memory d) { (,d,) = metadata(); }
    function socials() external view returns (string memory, string memory, string memory, string memory, string memory) {
        (,, Socials memory s) = metadata();
        return (s.twitter, s.telegram, s.discord, s.website, s.farcaster);
    }
    function getTokenInfo() external view returns (address, string memory, string memory, Socials memory) {
        (string memory l, string memory d, Socials memory s) = metadata();
        return (deployer, l, d, s);
    }
    function maxWalletLimit() public view returns (uint256) { return totalSupply() * maxWalletBps / 10_000; }
    function maxTxLimit() public view returns (uint256) { return totalSupply() * maxTxBps / 10_000; }
    /// @notice Current sniper fee on pool buys in bps; zero outside the restriction window.
    function buyFeeBps() public view returns (uint256) {
        if (sniperFeeBps == 0 || block.number <= launchBlock || block.number > restrictionEndBlock) return 0;
        return uint256(sniperFeeBps) * (restrictionEndBlock - block.number) / _restrictionBlocks;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (block.number <= restrictionEndBlock && from != address(0) && to != address(0) && _isPairPool(from)) {
            if (block.number == launchBlock) {
                if (to != deployer) revert LaunchBlockBuyBlocked();
            } else {
                uint256 fee = value * buyFeeBps() / 10_000;
                if (fee != 0) { value -= fee; super._update(from, locker, fee); }
                uint256 supply = totalSupply();
                if (balanceOf(to) + value > supply * maxWalletBps / 10_000) revert MaxWalletExceeded();
                uint256 cumulative = _restrictedPoolBuys[to] + value;
                if (cumulative > supply * maxTxBps / 10_000) revert MaxTxExceeded();
                _restrictedPoolBuys[to] = cumulative;
            }
        }
        super._update(from, to, value);
    }

    /// @dev Canonical pool first; any other factory-registered pool for this pair is also in scope.
    function _isPairPool(address candidate) private view returns (bool) {
        if (candidate == pool) return true;
        if (candidate == launchFactory || candidate.code.length == 0) return false;
        (bool ok, bytes memory data) = candidate.staticcall(abi.encodeCall(IUniswapV3PoolImmutablesLike.fee, ()));
        if (!ok || data.length < 32) return false;
        return IUniswapV3FactoryLike(dexFactory).getPool(address(this), pairToken, abi.decode(data, (uint24))) == candidate;
    }
}
