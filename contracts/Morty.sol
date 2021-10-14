//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@chainlink/contracts/src/v0.8/VRFConsumerBase.sol";


/// @notice Mortys -- https://www.paradigm.xyz/2021/09/martingale-shares/
contract Morty is ERC20, ERC721Holder, VRFConsumerBase {

    /// ------------------------------
    /// ------ Class Definition ------
    /// ------------------------------
    
    /// @notice defines the Morty class, i.e. the addresses and token IDs of the 
    /// ERC721s that can be used to open vaults 
    mapping(address => mapping(uint256 => bool)) public classMembers;

    /// --------------------
    /// ------ Vaults ------
    /// --------------------

    /// @notice possible states for a vault
    enum VaultState {inactive, active, settledForOwner, settledAgainstOwner, redeemed}

    /// @notice  id to be used for next created vault
    uint256 public currentVaultId = 1;

    /// @notice vault and all associated information
    struct Vault {
        uint256 id;
        address owner;
        address tokenAddress;
        uint256 tokenId;
        VaultState state;
        uint256 vMortyBalance;
        uint256 lastStepTime;
    }

    /// @notice initial vault vMorty balance, controls expected settlement time
    uint256 public initialVaultBalance;

    /// @notice time interval between martingale settlement steps 
    uint256 public constant stepInterval = 1 days;

    ///@notice mapping from vault ids to vaults
    mapping(uint256 => Vault) public vaultMap;

    /// ----------------------
    /// ------ Buy Pool ------
    /// ----------------------

    /// @notice the buy pool's vMorty balance
    uint256 public buyPoolVMortyBalance;

     /// @notice initial number of buy pool ownership token that represent 1 vMorty
    uint256 public constant initialExchangeRate = 1_000_000_000;

    /// ----------------------
    /// ------ Chainlink -----
    /// ----------------------

    /// @notice chainlink keyhash
    bytes32 keyHash;

    /// @notice chainlink fee
    uint256 fee;

    ///@notice mapping from chainlink requestId to vaultIds
    mapping(bytes32 => uint256) public requestIdToVaultIdMap;

    /// ------------------------
    /// -------- EVENTS --------
    /// ------------------------

    /// @notice An event emitted when a vault is created
    event CreateVault(address indexed creator, uint256 vaultId);

    /// @notice An event emitted when a shared are minted
    event MintShares(uint256 vaultId, uint256 vMortyAmount);

    /// @notice An event emitted when a step in the martingale settlement is taken
    event SettlementStep(uint256 vaultId, bool inFavorOfOwner);

    /// @notice An event emitted when the martingale settlement is completed
    event SettlementCompleted(uint256 vaultId, bool inFavorOfOwner);

    /// @notice An event emitted when collateral for a vault is replaced
    event ReplacedCollateral(uint256 vaultId);

    /// @notice An event emitted when collateral is redeemed 
    event RedeemedCollateral(uint256 vaultId, address redeemerId);

    /// @notice An event emitted when randomness is requested
    event RequestedRandomness(bytes32 requestId);


    ///@notice create a morty class 
    ///_tokenAddresses and _tokenIds are parallel arrays which are used to define class membership
    constructor(string memory _name
               ,string memory _symbol
               ,address[] memory _tokenAddresses
               ,uint256[] memory _tokenIds
               ,uint256 _initialVaultBalance
               ,address _vrfCoordinator
               ,address _link
               ,bytes32 _keyHash
               ,uint256 _fee
    ) ERC20(_name, _symbol) VRFConsumerBase(_vrfCoordinator, _link)
     {
        require(_tokenAddresses.length == _tokenIds.length, "token address and token id list must have same length");
        //put class members into classMember map
        for(uint i = 0; i < _tokenAddresses.length; i++) {
            address curAddress = _tokenAddresses[i];
            uint256 curId = _tokenIds[i];
            classMembers[curAddress][curId] = true;
        }
        initialVaultBalance = _initialVaultBalance;
        keyHash = _keyHash;
        fee = _fee;
    }

    ///@notice create a vault, transfering the given ERC721 to the morty contract
    function createVault(address tokenAddress, uint256 tokenId) public {
        require(isClassMember(tokenAddress, tokenId), "not a class member");
        
        ERC721(tokenAddress).safeTransferFrom(msg.sender, address(this), tokenId);
        
        //initialize vault state
        vaultMap[currentVaultId] = Vault({
            id: currentVaultId, 
            owner: msg.sender, 
            tokenAddress: tokenAddress, 
            tokenId: tokenId, 
            state: VaultState.inactive, 
            vMortyBalance: initialVaultBalance,
            lastStepTime: block.timestamp
        });

        emit CreateVault(msg.sender, currentVaultId);
        currentVaultId++;
    }

    ///@notice mint buy pool shares for a specified number of vMortys, and begin the martingale 
    /// settlement process if vault was previously inactive 
    function mintShares(uint256 vaultId, uint256 vMortyAmount) public {
        Vault storage vault = vaultMap[vaultId];
        require(vault.owner == msg.sender, "vault does not exist, or is not owned by sender");
        require(vault.state == VaultState.inactive || vault.state == VaultState.active);
        require(vMortyAmount > 0, "must mint at least one vMorty");
        require(vault.vMortyBalance >= vMortyAmount, "vault balance cannot be negative");
        //if buyPool has 0 balance, just use initial exchange rate
        if(buyPoolVMortyBalance == 0) {
            _mint(msg.sender, vMortyAmount * initialExchangeRate);
        }
        // if buy pool already has a balance, we need to ensure that the exchange rate between buy pool tokens 
        // and vMortys is invariant, i.e. each buy pool token should represent a claim over the same amount of vMortys
        // after mint. 
        else {
            uint256 newVMortyBuyPoolSupply = buyPoolVMortyBalance + vMortyAmount;
            uint256 newBuyPoolTokenSupply = newVMortyBuyPoolSupply * totalSupply() / buyPoolVMortyBalance;
            uint256 buyPoolTokenMintAmount = newBuyPoolTokenSupply - totalSupply();
            _mint(msg.sender, buyPoolTokenMintAmount);
        }
        //transfer vMorty balance from vault to buy pool 
        vault.vMortyBalance -= vMortyAmount;
        buyPoolVMortyBalance += vMortyAmount;

        //if vault was previously inactive, set timestamp to begin settlement process 
        //after one interval has elapsed from this point.  
        //We don't do this for active vaults to prevent stalling i.e. a user could 
        //mint a single vMorty every day to to delay settlement 
        if(vault.state == VaultState.inactive) {
            vault.lastStepTime = block.timestamp;
        }
        //update rest of vault state variables 
        vault.state = VaultState.active;
        updateVaultSettlementState(vault);
        emit MintShares(vaultId, vMortyAmount);
    }

    ///@notice take a step in the martingale settlement 
    function takeStep(uint256 vaultId) public {
        Vault storage vault = vaultMap[vaultId];
        require(vault.id == vaultId, "vault does not exist");
        require(vault.state == VaultState.active, "vault is not active");
        require(vault.lastStepTime + stepInterval < block.timestamp, "can't take another step yet");
        require(LINK.balanceOf(address(this)) >= fee, "Not enough LINK to generate randomness");
        vault.lastStepTime += stepInterval;
        //request randomeness from chainlink, to be fulfilled 
        bytes32 requestId = requestRandomness(keyHash, fee);
        requestIdToVaultIdMap[requestId] = vault.id;

        emit RequestedRandomness(requestId);
    }

    ///@notice update martingale settlement with randomnes from chainlink
    function fulfillRandomness(bytes32 requestId, uint256 randomness) internal override {
        uint256 vaultId = requestIdToVaultIdMap[requestId];
        Vault storage vault = vaultMap[vaultId];
        bool settledInFavor = (randomness % 2) == 1;

        if(settledInFavor) {
            vault.vMortyBalance++;
            buyPoolVMortyBalance--;
        } 
        else {
            vault.vMortyBalance--;
            buyPoolVMortyBalance++;
        }
        updateVaultSettlementState(vault);
        emit SettlementStep(vaultId, settledInFavor);
    }


    ///@notice replace vault collateral with another member of the class
    function replaceCollateral(uint256 vaultId, address tokenAddress, uint256 tokenId) public {
        Vault storage vault = vaultMap[vaultId];
        require(vault.id == vaultId, "vault does not exist");
        require(vault.owner == msg.sender, "sender does not own vault");
        require(isClassMember(tokenAddress, tokenId), "not a class member");

        address currentAddress = vault.tokenAddress;
        uint256 currentTokenId = vault.tokenId;

        ERC721(tokenAddress).safeTransferFrom(msg.sender, address(this), tokenId);
        ERC721(currentAddress).safeTransferFrom(address(this), msg.sender, currentTokenId);

        vault.tokenAddress = tokenAddress;
        vault.tokenId = tokenId;

        emit ReplacedCollateral(vaultId);
    }

    ///@notice redeem collateral by owner after vault settles in their favor
    function redeemByOwner(uint256 vaultId) public {
        Vault storage vault = vaultMap[vaultId];
        require(vault.id == vaultId, "vault does not exist");
        require(vault.owner == msg.sender, "sender does not own vault");
        require(vault.state == VaultState.settledForOwner, "vault has not settled for owner");

        ERC721(vault.tokenAddress).safeTransferFrom(address(this), msg.sender, vault.tokenId);
        vault.state = VaultState.redeemed;
        emit RedeemedCollateral(vaultId, msg.sender);
    }

    ///@notice redeem collateral by owner after vault settles in their favor
    function redeemByBuyer(uint256 vaultId) public {
        Vault storage vault = vaultMap[vaultId];
        require(vault.id == vaultId, "vault does not exist");
        require(vault.state == VaultState.settledAgainstOwner, "vault has not settled against owner");

        //calculate the amount of buyPoolTokens that represent a vault's initial vMorty balance
        uint256 exchangeRate = totalSupply() / buyPoolVMortyBalance;
        uint256 requiredTokens = exchangeRate * initialVaultBalance;
        
        //adjust balances, burn tokens and tranfer erc721
        _burn(msg.sender, requiredTokens);
        buyPoolVMortyBalance -= initialVaultBalance;
        ERC721(vault.tokenAddress).safeTransferFrom(address(this), msg.sender, vault.tokenId);
        vault.state = VaultState.redeemed;
        emit RedeemedCollateral(vaultId, msg.sender);
    }

    ///@notice update vault state if martingale settlement has concluded
    function updateVaultSettlementState(Vault storage vault) private {
        if (vault.vMortyBalance == 0) {
            vault.state = VaultState.settledAgainstOwner;
            emit SettlementCompleted(vault.id, false);
        }
        if (vault.vMortyBalance == initialVaultBalance) {
            vault.state = VaultState.settledForOwner;
             emit SettlementCompleted(vault.id, true);
        }
    }

    ///@notice check if a given token address and token id is part of the morty class
    function isClassMember(address tokenAddress, uint256 tokenId) public view returns (bool) { 
        return classMembers[tokenAddress][tokenId];
    }
}