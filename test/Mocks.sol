// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPonsLaunchFactory, INonfungiblePositionManagerLike, IERC721ReceiverLike} from "../src/vendor/pons-v1/interfaces/ILaunchpad.sol";
import {BitbankLaunchLocker} from "../src/BitbankLaunchLocker.sol";

contract MockAsset is ERC20 { constructor() ERC20("Asset","ASSET") {} function mint(address to,uint256 amount) external {_mint(to,amount);} }
contract MockWETH is ERC20 { constructor() ERC20("Wrapped Ether","WETH") {} function deposit() external payable {_mint(msg.sender,msg.value);} function mint(address to,uint256 amount) external {_mint(to,amount);} }

/// Pool that simply holds the launch supply and hands tokens out to buyers (V3 transfers out tokenOut directly).
contract MockPool {
    address public token0; address public token1; uint24 public fee; address public manager;
    constructor(address a,address b,uint24 f){token0=a;token1=b;fee=f;manager=msg.sender;}
    function swapOut(address token,address to,uint256 amount) external { require(msg.sender==manager); IERC20(token).transfer(to,amount); }
}

/// V3 factory + position manager + router in one mock. Mints NFT id 1,2,... and moves the whole supply into the pool.
contract MockDex {
    mapping(bytes32=>address) private pools;
    mapping(uint256=>address) public ownerOf;
    mapping(uint256=>address) public positionToken;
    uint256 public nextId=1; uint256 public feeAmount; MockWETH public weth;
    constructor(MockWETH w){weth=w;}
    function key(address a,address b,uint24 f) private pure returns(bytes32){ (a,b)=a<b?(a,b):(b,a); return keccak256(abi.encode(a,b,f)); }
    function getPool(address a,address b,uint24 f) external view returns(address){return pools[key(a,b,f)];}
    function createAndInitializePoolIfNecessary(address a,address b,uint24 f,uint160) external payable returns(address pool){
        pool=pools[key(a,b,f)]; if(pool==address(0)){pool=address(new MockPool(a,b,f));pools[key(a,b,f)]=pool;}
    }
    function createPool(address a,address b,uint24 f) external returns(address pool){ pool=address(new MockPool(a,b,f));pools[key(a,b,f)]=pool; }
    function mint(INonfungiblePositionManagerLike.MintParams calldata p) external payable returns(uint256 id,uint128,uint256,uint256){
        address pool=pools[key(p.token0,p.token1,p.fee)]; require(pool!=address(0));
        address token=p.amount0Desired!=0?p.token0:p.token1; uint256 amount=p.amount0Desired!=0?p.amount0Desired:p.amount1Desired;
        IERC20(token).transferFrom(msg.sender,pool,amount);
        id=nextId++; ownerOf[id]=p.recipient; positionToken[id]=token;
        return(id,uint128(amount),p.amount0Desired,p.amount1Desired);
    }
    function safeTransferFrom(address from,address to,uint256 id) external {
        require(ownerOf[id]==from && msg.sender==from); ownerOf[id]=to;
        require(IERC721ReceiverLike(to).onERC721Received(msg.sender,from,id,"")==IERC721ReceiverLike.onERC721Received.selector);
    }
    function setFeeAmount(uint256 a) external {feeAmount=a;}
    function collect(INonfungiblePositionManagerLike.CollectParams calldata p) external payable returns(uint256,uint256){
        require(msg.sender==ownerOf[p.tokenId]); weth.mint(p.recipient,feeAmount);
        if (positionToken[p.tokenId]<address(weth)) return (0,feeAmount); return (feeAmount,0);
    }
    /// Router: buyer pays native value, pool sends `tokensOut` of tokenOut to recipient.
    uint256 public tokensOut; address public buyRecipient;
    function setTokensOut(uint256 t) external {tokensOut=t;}
    function setBuyRecipient(address r) external {buyRecipient=r;}
    struct ExactInputSingleParams{address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 deadline;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    struct ExactInputSingleParams02{address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns(uint256){
        require(msg.value==p.amountIn && p.deadline>=block.timestamp); return _buy(p.tokenIn,p.tokenOut,p.fee,p.recipient);
    }
    function exactInputSingle(ExactInputSingleParams02 calldata p) external payable returns(uint256){
        require(msg.value==p.amountIn); return _buy(p.tokenIn,p.tokenOut,p.fee,p.recipient);
    }
    function _buy(address tokenIn,address tokenOut,uint24 fee,address recipient) private returns(uint256){
        address to=buyRecipient==address(0)?recipient:buyRecipient;
        MockPool(pools[key(tokenIn,tokenOut,fee)]).swapOut(tokenOut,to,tokensOut); return tokensOut;
    }
    function buyFrom(address pool,address token,address to,uint256 amount) external { MockPool(pool).swapOut(token,to,amount); }
}

contract MockLaunchFactory is IPonsLaunchFactory {
    LaunchedToken private record;
    function protocolFeeRecipient() external pure returns(address){return address(1);}
    function getLaunchedToken(address) external view returns(LaunchedToken memory){return record;}
    function setup(BitbankLaunchLocker locker,address token,address pair,address manager,address recipient,uint24 fee) external {
        record=LaunchedToken(token,recipient,pair,manager,1,0,0,0,1 ether,true,fee,true,0);locker.lockPosition(token);
    }
    function redirect(BitbankLaunchLocker locker,address token,address recipient) external {locker.setFeeRedirect(token,recipient);}
}
contract MockManager {
    address public holder; MockAsset public asset0; MockAsset public asset1; uint256 public amount;
    constructor(address holder_, MockAsset a, MockAsset b){holder=holder_;asset0=a;asset1=b;}
    function ownerOf(uint256) external view returns(address){return holder;}
    function setAmount(uint256 a) external {amount=a;}
    function collect(INonfungiblePositionManagerLike.CollectParams calldata p) external returns(uint256,uint256){require(msg.sender==holder);asset0.mint(p.recipient,amount);asset1.mint(p.recipient,amount);return(amount,amount);}
}
contract MockPermitToken is ERC20 {
    bytes32 private constant PERMIT_TYPEHASH=keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address=>uint256) public nonces;
    constructor() ERC20("USD Coin","USDC") {}
    function decimals() public pure override returns(uint8){return 6;}
    function mint(address to,uint256 amount) external {_mint(to,amount);}
    function DOMAIN_SEPARATOR() public view returns(bytes32){return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256(bytes(name())),keccak256("1"),block.chainid,address(this)));}
    function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s) external {
        require(block.timestamp<=deadline,"expired");
        bytes32 digest=keccak256(abi.encodePacked("\x19\x01",DOMAIN_SEPARATOR(),keccak256(abi.encode(PERMIT_TYPEHASH,owner,spender,value,nonces[owner]++,deadline))));
        require(ecrecover(digest,v,r,s)==owner,"bad sig");
        _approve(owner,spender,value);
    }
}
contract RejectEth { receive() external payable { revert(); } }
