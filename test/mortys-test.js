const { expect } = require("chai");
const { address } = require("faker");
const { ethers } = require("hardhat");

//issue with chainlink provided mocks causes extra WARNING logs 
//in current version of ethers. Restricting logs to ERROR only until patch. 
//See  https://github.com/ethers-io/ethers.js/issues/905 
const Logger = ethers.utils.Logger;
Logger.setLogLevel(Logger.levels.ERROR)

describe("Mortys", function () {

  let owner;
  let addr1;
  let addr2;
  let addrs;

  let erc721A;
  let erc721B;

  let tokenAddresses;
  let tokenIds;

  let vrfCoordinatorMock;

  const mintIds = [1, 2, 3]

  //hardhat network
  const fee = ethers.BigNumber.from("100000000000000000");
  const keyHash = '0x6c3699283bda56ad74f6b855546325b68d482e983852a7a82979cc4807b641f4';

  let morty;

  const vaultState = {
    inactive: 0,
    active: 1,
    settledForOwner: 2,
    settledAgainstOwner: 3,
    redeemed: 4
  };

  const initialVMortyBalance = 10;
  const initialVaultId = 1;

  async function increaseBlockTime(seconds) {
    await network.provider.send("evm_increaseTime", [seconds])
    await network.provider.send("evm_mine")
  }

  async function takeStep(vaultId, stepInFavorOfOwner) {
    const stepInterval = await morty.stepInterval()
    await increaseBlockTime(stepInterval.toNumber())
    const transaction = await morty.takeStep(vaultId);
    const tx_receipt = await transaction.wait();
    const requestId = tx_receipt.events[3].data
    const id = await morty.requestIdToVaultIdMap(requestId);
    const v = await morty.vaultMap(id);

    const randomness = stepInFavorOfOwner ? 1 : 0
    await vrfCoordinatorMock.callBackWithRandomness(requestId, randomness, morty.address)
  }

  async function settleMartingale(vaultId, inFavorOfOwner) {
    const vault = await morty.vaultMap(initialVaultId);
    const vaultBalance = vault.vMortyBalance;
    const numSteps = inFavorOfOwner ? initialVMortyBalance - vaultBalance : vaultBalance;
    for (let i = 0; i < numSteps; i++) {
      await takeStep(vaultId, inFavorOfOwner);
    }
  }

  beforeEach(async function () {

    [owner, addr1, addr2, ...addrs] = await ethers.getSigners();

    const linkTokenFactory = await ethers.getContractFactory("LinkToken");
    const linkToken = await linkTokenFactory.deploy();

    const vrfCoordinatorMockFactory = await ethers.getContractFactory("VRFCoordinatorMock");
    vrfCoordinatorMock = await vrfCoordinatorMockFactory.deploy(linkToken.address)

    const erc721Mock = await ethers.getContractFactory("ERC721Mock");
    erc721A = await erc721Mock.deploy("NFTA", "NFTA");
    erc721B = await erc721Mock.deploy("NFTB", "NFTB");
    await erc721A.mint(mintIds)
    await erc721B.mint(mintIds)

    tokenAddresses = [erc721A.address, erc721B.address];
    tokenIds = [1, 2];

    await erc721A.transferFrom(owner.address, addr1.address, 1);
    await erc721A.transferFrom(owner.address, addr1.address, 2);
    await erc721B.transferFrom(owner.address, addr1.address, 1);
    await erc721B.transferFrom(owner.address, addr1.address, 2);

    const mortyFactory = await ethers.getContractFactory("Morty");

    morty = await mortyFactory.deploy(
      "Morty"
      , "MRT"
      , tokenAddresses
      , tokenIds
      , initialVMortyBalance
      , vrfCoordinatorMock.address
      , linkToken.address
      , keyHash
      , fee
    );

    await linkToken.transfer(morty.address, fee.mul(100));
    await erc721A.connect(addr1).approve(morty.address, 1);
    await erc721B.connect(addr1).approve(morty.address, 2);
    await morty.connect(addr1).createVault(tokenAddresses[0], tokenIds[0]);

  });

  describe("class membership", function () {

    it("defines class membership correctly", async function () {
      expect(await morty.isClassMember(erc721A.address, 1)).to.be.true;
      expect(await morty.isClassMember(erc721B.address, 1)).to.be.false;
    });

  });

  describe("vault creation", function () {

    it("is able to create vault with member of class", async function () {
      expect(await erc721A.ownerOf(tokenIds[0])).to.eq(morty.address);

      const vault = await morty.vaultMap(initialVaultId);
      expect(vault.owner).to.eq(addr1.address);
      expect(vault.state).to.eq(vaultState['inactive']);
      expect(vault.vMortyBalance).to.eq(initialVMortyBalance);
      expect(vault.tokenAddress).to.eq(tokenAddresses[0]);
      expect(vault.tokenId).to.eq(tokenIds[0]);

    });

    it("is not able to create vault with non-member of class", async function () {
      await expect(
        morty.connect(addr1).createVault(tokenAddresses[0], 2)
      ).to.be.revertedWith("not a class member");
    });
  });

  describe("collateral swaps", function () {

    it("is able to replace collateral with member of class", async function () {
      expect(await erc721A.ownerOf(tokenIds[0])).to.eq(morty.address);
      expect(await erc721B.ownerOf(tokenIds[1])).to.eq(addr1.address);

      await morty.connect(addr1).replaceCollateral(initialVaultId, tokenAddresses[1], tokenIds[1]);

      expect(await erc721A.ownerOf(tokenIds[0])).to.eq(addr1.address);
      expect(await erc721B.ownerOf(tokenIds[1])).to.eq(morty.address);
    });

    it("is not able to replace collateral with non-member of class", async function () {
      await expect(
        morty.connect(addr1).replaceCollateral(initialVaultId, tokenAddresses[0], 2)
      ).to.be.revertedWith("not a class member");
    });
  });

  describe("minting", function () {


    it("is able to mint initial shares", async function () {
      const mintAmount = initialVMortyBalance / 2;
      let vault = await morty.vaultMap(initialVaultId);
      const initialVaultBalance = vault.vMortyBalance;
      expect(initialVaultBalance).to.eq(initialVMortyBalance);

      await morty.connect(addr1).mintShares(initialVaultId, mintAmount);
      vault = await morty.vaultMap(initialVaultId);
      expect(vault.vMortyBalance).to.eq(initialVaultBalance - mintAmount);
      expect(await morty.buyPoolVMortyBalance()).to.eq(mintAmount)

      const expectedBuyPoolTokens = await morty.initialExchangeRate() * mintAmount;

      expect(await morty.balanceOf(addr1.address)).to.eq(expectedBuyPoolTokens);
      expect(await morty.totalSupply()).to.eq(expectedBuyPoolTokens);

    });

    it("is able to mint additional shares", async function () {
      const initialMint = Math.floor(initialVMortyBalance / 2);
      const secondMint = Math.floor(initialVMortyBalance / 3);
      const totalMint = initialMint + secondMint;

      let vault = await morty.vaultMap(initialVaultId);
      const initialVaultBalance = vault.vMortyBalance;

      await morty.connect(addr1).mintShares(initialVaultId, initialMint);
      await morty.connect(addr1).mintShares(initialVaultId, secondMint);

      vault = await morty.vaultMap(initialVaultId);
      expect(vault.vMortyBalance).to.eq(initialVaultBalance - totalMint);
      expect(await morty.buyPoolVMortyBalance()).to.eq(totalMint)

    });

    it("is not able to mint shares over limit", async function () {
      const initialMint = initialVMortyBalance + 1;
      await expect(
        morty.connect(addr1).mintShares(initialVaultId, initialMint)
      ).to.be.revertedWith("vault balance cannot be negative");
    });

    it("exchange rate is invariant over mints", async function () {
      const initialMint = Math.floor(initialVMortyBalance / 2);
      const secondMint = Math.floor(initialVMortyBalance / 3);

      await morty.connect(addr1).mintShares(initialVaultId, initialMint);
      let buyPoolBalance = await morty.buyPoolVMortyBalance()
      let totalSupply = await morty.totalSupply();
      const initialExchangeRate = totalSupply / buyPoolBalance;

      await morty.connect(addr1).createVault(tokenAddresses[1], tokenIds[1]);

      await morty.connect(addr1).mintShares(initialVaultId + 1, secondMint);
      buyPoolBalance = await morty.buyPoolVMortyBalance()
      totalSupply = await morty.totalSupply();
      const finalExchangeRate = totalSupply / buyPoolBalance;

      expect(initialExchangeRate).to.eq(finalExchangeRate);
    });
  });

  describe("martingale settlement", function () {
    it("updates balances correctly", async function () {
      const mintAmount = Math.floor(initialVMortyBalance / 2);
      await morty.connect(addr1).mintShares(initialVaultId, mintAmount);
      let vault = await morty.vaultMap(initialVaultId);
      const initialVaultBalance = vault.vMortyBalance;
      const initialBuyPoolBalance = await morty.buyPoolVMortyBalance();

      const stepInFavor = true;
      await takeStep(initialVaultId, stepInFavor);

      const vault2 = await morty.vaultMap(initialVaultId);
      const finalVaultBalance = vault2.vMortyBalance;
      const finalBuyPoolBalance = await morty.buyPoolVMortyBalance();
      expect(finalVaultBalance).to.eq(initialVaultBalance.add(1));
      expect(finalBuyPoolBalance).to.eq(initialBuyPoolBalance.sub(1));
    });

    it("does not allow step before time interval", async function () {
      const mintAmount = Math.floor(initialVMortyBalance / 2);
      await morty.connect(addr1).mintShares(initialVaultId, mintAmount);
      
      await expect(
        morty.takeStep(initialVaultId)
      ).to.be.revertedWith("can't take another step yet");
    });

    it("exchange rate is invariant after pool loss", async function () {
      const initialMint = Math.floor(initialVMortyBalance / 2);
      const secondMint = Math.floor(initialVMortyBalance / 3);

      await morty.connect(addr1).mintShares(initialVaultId, initialMint);
      await takeStep(initialVaultId, true);

      let buyPoolBalance = await morty.buyPoolVMortyBalance()
      let totalSupply = await morty.totalSupply();
      const initialExchangeRate = totalSupply / buyPoolBalance;

      await morty.connect(addr1).createVault(tokenAddresses[1], tokenIds[1]);

      await morty.connect(addr1).mintShares(initialVaultId + 1, secondMint);
      buyPoolBalance = await morty.buyPoolVMortyBalance()
      totalSupply = await morty.totalSupply();
      const finalExchangeRate = totalSupply / buyPoolBalance;

      expect(initialExchangeRate).to.eq(finalExchangeRate);
    });
  });

  describe("redemptions", function () {
    it("allows redemption by owner", async function () {
      const initialMint = Math.floor(initialVMortyBalance / 2);

      await morty.connect(addr1).mintShares(initialVaultId, initialMint);
      await settleMartingale(initialVaultId, true);

      let vault = await morty.vaultMap(initialVaultId);
      expect(vault.state).to.eq(vaultState['settledForOwner'])

      let curOwner = await erc721A.ownerOf(tokenIds[0]);
      expect(curOwner).to.eq(morty.address);

      await morty.connect(addr1).redeemByOwner(initialVaultId);

      vault = await morty.vaultMap(initialVaultId);
      expect(vault.state).to.eq(vaultState['redeemed'])

      curOwner = await erc721A.ownerOf(tokenIds[0]);
      expect(curOwner).to.eq(addr1.address);
    });

    it("allows redemption by buy pool", async function () {
      const initialMint = Math.floor(initialVMortyBalance / 2);

      await morty.connect(addr1).mintShares(initialVaultId, initialMint);
      await settleMartingale(initialVaultId, false);

      let vault = await morty.vaultMap(initialVaultId);
      expect(vault.state).to.eq(vaultState['settledAgainstOwner'])

      let curOwner = await erc721A.ownerOf(tokenIds[0]);
      expect(curOwner).to.eq(morty.address);

      const tokenSupply = await morty.totalSupply();
      await morty.connect(addr1).transfer(addr2.address, tokenSupply);
      await morty.connect(addr2).redeemByBuyer(initialVaultId);

      vault = await morty.vaultMap(initialVaultId);
      expect(vault.state).to.eq(vaultState['redeemed'])

      curOwner = await erc721A.ownerOf(tokenIds[0]);
      expect(curOwner).to.eq(addr2.address);
    });

    it("prevents redemption before settlement", async function () {
      const initialMint = Math.floor(initialVMortyBalance / 2);
      await morty.connect(addr1).mintShares(initialVaultId, initialMint);

      await expect(
        morty.connect(addr1).redeemByOwner(initialVaultId)
      ).to.be.revertedWith("vault has not settled for owner");
    });
  });
});

