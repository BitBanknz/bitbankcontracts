// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPonsLaunchFactory, INonfungiblePositionManagerLike} from "../src/vendor/pons-v1/interfaces/ILaunchpad.sol";
import {BitbankLaunchLocker} from "../src/BitbankLaunchLocker.sol";
contract MockAsset is ERC20 { constructor() ERC20("Asset","ASSET") {} function mint(address to,uint256 amount) external {_mint(to,amount);} }
contract MockManager {
 address public holder; MockAsset public asset0; MockAsset public asset1; uint256 public amount;
 constructor(address holder_, MockAsset a, MockAsset b){holder=holder_;asset0=a;asset1=b;}
 function ownerOf(uint256) external view returns(address){return holder;}
 function setAmount(uint256 a) external {amount=a;}
 function collect(INonfungiblePositionManagerLike.CollectParams calldata p) external returns(uint256,uint256){require(msg.sender==holder);asset0.mint(p.recipient,amount);asset1.mint(p.recipient,amount);return(amount,amount);}
}
contract MockLaunchFactory is IPonsLaunchFactory {
 LaunchedToken private record;
 function getLaunchedToken(address) external view returns(LaunchedToken memory){return record;}
 function setup(BitbankLaunchLocker locker,address token,address pair,address manager,address recipient,uint24 fee) external {
 record=LaunchedToken(token,recipient,pair,manager,1,0,0,0,1 ether,true,fee,true,0);locker.lockPosition(token);
 }
 function redirect(BitbankLaunchLocker locker,address token,address recipient) external {locker.setFeeRedirect(token,recipient);}
}
