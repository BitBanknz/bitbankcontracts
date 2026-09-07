// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Bitbank adaptation of the Pons Family V1 factory (src/vendor/pons-v1/PonsLaunchFactory.sol).
// Changes: 1% pool / 200 spacing only, exact CREATE2 salts, packed launch records, cached
// protocol recipient, sniper-fee launch presets, Bitbank token. Upstream Pons deployment
// 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB is a reference only; this contract has no deployment.

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BitbankLauncherToken} from "./BitbankLauncherToken.sol";
import {PonsTickMath} from "./vendor/pons-v1/libraries/PonsTickMath.sol";
import {
    INonfungiblePositionManagerLike,
    IPonsLaunchFactory,
    IPonsLaunchLocker,
    ISwapRouter02Like,
    ISwapRouterV3Like,
    IUniswapV3FactoryLike
} from "./vendor/pons-v1/interfaces/ILaunchpad.sol";

/// @notice Single-transaction launch: CREATE2 token, one-sided 1% V3 position, permanent lock,
/// optional creator initial buy from surplus native value.
contract BitbankLaunchFactory is Ownable2Step, ReentrancyGuard, IPonsLaunchFactory {
    using SafeERC20 for IERC20;

    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;
    int24 private constant TICK_SPACING = 200;
    uint24 private constant POOL_FEE = 10_000;
    uint256 private constant BASIS_POINTS = 10_000;

    struct TokenParams {
        string name;
        string symbol;
        string logo;
        string description;
        BitbankLauncherToken.Socials socials;
        address feeWallet;
        bool sniperFeeDisabled;
    }
    struct DexConfig {
        address factory;
        address positionManager;
        address swapRouter;
        uint24 poolFee;
        int24 tickSpacing;
        bool enabled;
    }
    /// @dev Field order packs storage into three slots.
    struct LaunchConfig {
        address pairToken;
        int24 initialTick;
        uint16 maxWalletBps;
        uint16 maxTxBps;
        uint32 restrictionBlocks;
        uint16 sniperFeeBps;
        bool enabled;
        bool routerRequiresDeadline;
        uint256 supply;
    }
    /// @dev Five slots. `deployer == 0` means no launch.
    struct Launch {
        address deployer;
        bool isToken0;
        uint32 dexId;
        uint32 launchConfigId;
        uint24 poolFee;
        uint96 positionId;
        uint64 restrictionsEndBlock;
        uint96 initialBuyAmount;
        address pairedToken;
        address positionManager;
        uint256 supply;
    }

    error InvalidDexConfig();
    error InvalidDexId();
    error DexDisabled();
    error InvalidLaunchConfigId();
    error InvalidLaunchConfig();
    error LaunchConfigDisabled();
    error LaunchFeeNotPaid();
    error NotWhitelisted();
    error FeeTransferFailed();
    error TokenDeploymentFailed();
    error RouterNotSet();
    error ZeroAddress();
    error InvalidTokenParams();

    event TokenLaunched(
        address indexed token,
        address indexed deployer,
        address indexed dexFactory,
        address pairToken,
        address pool,
        uint256 dexId,
        uint256 launchConfigId,
        uint256 positionId,
        uint256 restrictionsEndBlock,
        uint256 initialBuyAmount
    );
    event DexConfigAdded(uint256 indexed id, DexConfig config);
    event DexStatusUpdated(uint256 indexed id, bool enabled);
    event LaunchConfigSet(uint256 indexed id, LaunchConfig config);
    event LaunchFeeUpdated(uint256 launchFee);
    event LaunchEnabledUpdated(bool enabled);
    event WhitelistedLauncherUpdated(address indexed launcher, bool enabled);

    address public immutable locker;
    /// @dev Immutable in the locker, so cached here to skip a call per launch.
    address public immutable protocolFeeRecipient;
    uint256 public launchFee;
    bool public launchEnabled;
    mapping(address launcher => bool enabled) public whitelistedLaunchers;
    mapping(address token => Launch launch) private _launches;
    DexConfig[] private _dexConfigs;
    LaunchConfig[] private _launchConfigs;

    constructor(address initialOwner, address locker_, uint256 initialLaunchFee) Ownable(initialOwner) {
        if (locker_ == address(0)) revert ZeroAddress();
        address recipient = IPonsLaunchLocker(locker_).protocolFeeRecipient();
        if (recipient == address(0)) revert ZeroAddress();
        locker = locker_;
        protocolFeeRecipient = recipient;
        launchFee = initialLaunchFee;
    }

    function dexConfigCount() external view returns (uint256) { return _dexConfigs.length; }
    function launchConfigCount() external view returns (uint256) { return _launchConfigs.length; }
    function getDexConfig(uint256 id) external view returns (DexConfig memory) {
        if (id >= _dexConfigs.length) revert InvalidDexId();
        return _dexConfigs[id];
    }
    function getLaunchConfig(uint256 id) external view returns (LaunchConfig memory) {
        if (id >= _launchConfigs.length) revert InvalidLaunchConfigId();
        return _launchConfigs[id];
    }
    /// @notice Launch record in the shared Pons-compatible shape.
    function getLaunchedToken(address token) external view override returns (LaunchedToken memory r) {
        Launch storage l = _launches[token];
        if (l.deployer == address(0)) return r;
        r.token = token;
        r.deployer = l.deployer;
        r.pairedToken = l.pairedToken;
        r.positionManager = l.positionManager;
        r.positionId = l.positionId;
        r.dexId = l.dexId;
        r.launchConfigId = l.launchConfigId;
        r.restrictionsEndBlock = l.restrictionsEndBlock;
        r.supply = l.supply;
        r.isToken0 = l.isToken0;
        r.poolFee = l.poolFee;
        r.exists = true;
        r.initialBuyAmount = l.initialBuyAmount;
    }

    function addDexConfig(DexConfig calldata config) external onlyOwner returns (uint256 id) {
        if (
            config.factory == address(0) || config.positionManager == address(0) || config.poolFee != POOL_FEE
                || config.tickSpacing != TICK_SPACING
        ) revert InvalidDexConfig();
        id = _dexConfigs.length;
        _dexConfigs.push(config);
        emit DexConfigAdded(id, config);
    }
    function setDexStatus(uint256 id, bool enabled) external onlyOwner {
        if (id >= _dexConfigs.length) revert InvalidDexId();
        _dexConfigs[id].enabled = enabled;
        emit DexStatusUpdated(id, enabled);
    }
    function addLaunchConfig(LaunchConfig calldata config) external onlyOwner returns (uint256 id) {
        _validateLaunchConfig(config);
        id = _launchConfigs.length;
        _launchConfigs.push(config);
        emit LaunchConfigSet(id, config);
    }
    function updateLaunchConfig(uint256 id, LaunchConfig calldata config) external onlyOwner {
        if (id >= _launchConfigs.length) revert InvalidLaunchConfigId();
        _validateLaunchConfig(config);
        _launchConfigs[id] = config;
        emit LaunchConfigSet(id, config);
    }
    function setLaunchFee(uint256 newLaunchFee) external onlyOwner {
        launchFee = newLaunchFee;
        emit LaunchFeeUpdated(newLaunchFee);
    }
    function setLaunchEnabled(bool enabled) external onlyOwner {
        launchEnabled = enabled;
        emit LaunchEnabledUpdated(enabled);
    }
    function setWhitelistedLauncher(address launcher, bool enabled) external onlyOwner {
        if (launcher == address(0)) revert ZeroAddress();
        whitelistedLaunchers[launcher] = enabled;
        emit WhitelistedLauncherUpdated(launcher, enabled);
    }

    /// @notice Deploys, pools, locks, records and optionally buys in one transaction.
    /// @dev Native value above `launchFee` is spent on the creator's initial buy.
    function launchToken(TokenParams calldata params, uint256 launchConfigId, uint256 dexId, bytes32 salt)
        external
        payable
        nonReentrant
        returns (address token)
    {
        if (!launchEnabled && !whitelistedLaunchers[msg.sender]) revert NotWhitelisted();
        uint256 fee = launchFee;
        if (msg.value < fee) revert LaunchFeeNotPaid();
        if (dexId >= _dexConfigs.length) revert InvalidDexId();
        if (launchConfigId >= _launchConfigs.length) revert InvalidLaunchConfigId();
        if (bytes(params.name).length == 0 || bytes(params.symbol).length == 0) revert InvalidTokenParams();
        DexConfig storage dex = _dexConfigs[dexId];
        LaunchConfig storage config = _launchConfigs[launchConfigId];
        if (!dex.enabled) revert DexDisabled();
        if (!config.enabled) revert LaunchConfigDisabled();

        address pairToken = config.pairToken;
        uint256 supply = config.supply;
        address dexFactory = dex.factory;
        address positionManager = dex.positionManager;
        {
            bytes memory creationCode = _creationCode(params, config, dexFactory, msg.sender);
            token = _computeCreate2Address(salt, keccak256(creationCode));
            if (token.code.length != 0 || IUniswapV3FactoryLike(dexFactory).getPool(token, pairToken, POOL_FEE) != address(0)) {
                revert TokenDeploymentFailed();
            }
            address deployed;
            assembly ("memory-safe") {
                deployed := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
            }
            if (deployed != token) revert TokenDeploymentFailed();
        }

        bool isToken0 = token < pairToken;
        int24 initialTick = config.initialTick;
        INonfungiblePositionManagerLike manager = INonfungiblePositionManagerLike(positionManager);
        (address token0, address token1) = isToken0 ? (token, pairToken) : (pairToken, token);
        address pool = manager.createAndInitializePoolIfNecessary(
            token0, token1, POOL_FEE, PonsTickMath.getSqrtRatioAtTick(isToken0 ? initialTick : -initialTick)
        );
        BitbankLauncherToken(token).setPool(pool);

        // Whole supply as one-sided liquidity on the token side of the starting price.
        (int24 tickLower, int24 tickUpper) = isToken0
            ? (initialTick, (MAX_TICK / TICK_SPACING) * TICK_SPACING)
            : ((MIN_TICK / TICK_SPACING) * TICK_SPACING, -initialTick);
        IERC20(token).forceApprove(positionManager, supply);
        (uint256 positionId,,,) = manager.mint(
            INonfungiblePositionManagerLike.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: isToken0 ? supply : 0,
                amount1Desired: isToken0 ? 0 : supply,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        uint256 initialBuyAmount = msg.value - fee;
        uint256 restrictionEndBlock = block.number + config.restrictionBlocks;
        if (positionId > type(uint96).max || initialBuyAmount > type(uint96).max) revert TokenDeploymentFailed();
        _launches[token] = Launch({
            deployer: msg.sender,
            isToken0: isToken0,
            dexId: uint32(dexId),
            launchConfigId: uint32(launchConfigId),
            poolFee: POOL_FEE,
            positionId: uint96(positionId),
            restrictionsEndBlock: uint64(restrictionEndBlock),
            initialBuyAmount: uint96(initialBuyAmount),
            pairedToken: pairToken,
            positionManager: positionManager,
            supply: supply
        });

        manager.safeTransferFrom(address(this), locker, positionId);
        IPonsLaunchLocker(locker).lockPosition(token);
        if (params.feeWallet != address(0)) IPonsLaunchLocker(locker).setFeeRedirect(token, params.feeWallet);

        emit TokenLaunched(
            token, msg.sender, dexFactory, pairToken, pool, dexId, launchConfigId, positionId, restrictionEndBlock, initialBuyAmount
        );

        if (fee != 0) {
            (bool sent,) = payable(protocolFeeRecipient).call{value: fee}("");
            if (!sent) revert FeeTransferFailed();
        }
        if (initialBuyAmount != 0) {
            address router = dex.swapRouter;
            if (router == address(0)) revert RouterNotSet();
            _initialBuy(router, config.routerRequiresDeadline, pairToken, token, initialBuyAmount);
        }
    }

    function predictTokenAddress(
        TokenParams calldata params,
        uint256 launchConfigId,
        uint256 dexId,
        bytes32 salt,
        address tokenDeployer
    ) external view returns (address) {
        if (dexId >= _dexConfigs.length) revert InvalidDexId();
        if (launchConfigId >= _launchConfigs.length) revert InvalidLaunchConfigId();
        return _computeCreate2Address(
            salt, keccak256(_creationCode(params, _launchConfigs[launchConfigId], _dexConfigs[dexId].factory, tokenDeployer))
        );
    }

    function _creationCode(TokenParams calldata params, LaunchConfig storage config, address dexFactory, address tokenDeployer)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(BitbankLauncherToken).creationCode,
            abi.encode(
                params.name,
                params.symbol,
                abi.encode(params.logo, params.description, params.socials),
                tokenDeployer,
                dexFactory,
                config.pairToken,
                locker,
                POOL_FEE,
                config.supply,
                config.maxWalletBps,
                config.maxTxBps,
                config.restrictionBlocks,
                params.sniperFeeDisabled ? 0 : config.sniperFeeBps
            )
        );
    }

    function _computeCreate2Address(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    function _validateLaunchConfig(LaunchConfig calldata config) private pure {
        if (config.pairToken == address(0)) revert ZeroAddress();
        uint256 derived = uint256(config.maxWalletBps) * 110 / 100;
        if (
            config.maxWalletBps > BASIS_POINTS || config.maxTxBps != (derived > BASIS_POINTS ? BASIS_POINTS : derived)
                || config.sniperFeeBps > BASIS_POINTS || config.supply < 1 ether || config.initialTick < MIN_TICK
                || config.initialTick > MAX_TICK || config.initialTick == 0 || config.initialTick % TICK_SPACING != 0
                || (config.sniperFeeBps != 0 && config.restrictionBlocks == 0)
        ) revert InvalidLaunchConfig();
    }

    function _initialBuy(address router, bool requiresDeadline, address pairToken, address token, uint256 amountIn) private {
        if (requiresDeadline) {
            ISwapRouterV3Like(router).exactInputSingle{value: amountIn}(
                ISwapRouterV3Like.ExactInputSingleParams({
                    tokenIn: pairToken,
                    tokenOut: token,
                    fee: POOL_FEE,
                    recipient: msg.sender,
                    deadline: block.timestamp,
                    amountIn: amountIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            return;
        }
        ISwapRouter02Like(router).exactInputSingle{value: amountIn}(
            ISwapRouter02Like.ExactInputSingleParams({
                tokenIn: pairToken,
                tokenOut: token,
                fee: POOL_FEE,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
