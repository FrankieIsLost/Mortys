# Mortys

## Introduction

An implementation of [Mortys](https://www.paradigm.xyz/2021/09/martingale-shares/), an NFT primitive by [@\_Dave\_\_White\_](https://twitter.com/_Dave__White_). Mortys are a mechanism that allows fractionalization without the need for buyouts or oracles by relying on a martingale settlement process. 

## Implementation Notes

A few notes on the current implementation:

### Long Variance & Virtual Mortys

The main implementation challenge with the Mortys mechanism comes from what the original paper describes as "long variance". After every coin flip, the morty balance of every member in the buy pool must be adjusted, as they collectively win or lose a morty. If you directly represent Mortys as an ERC20, this becomes difficult to do efficiently. The original paper presents a clever trick of using "auto-cancelling" flips to eliminate long variance: form pairs of vaults at random, flip a single coin, and assign each vault a different outcome based on the flip. Unfortunatelly the trick does not work in the case of a single vault. 

A solution to this problem is to use "virtual mortys". Instead of having each ERC20 directly represent a Morty, each token instead represents an equal share of the buy pool. Each vault and the buy pool have an internal balance of "virtual mortys", and the martingale settlement works on these virtual balances. 

When Alice withdraws mortys from her vault, these mortys go directly into the buy pool, and Alice instead receives an equivalent share of the pool, which she can proceed to sell. This representation means we we only need to transfer ERC20 during minting and redemption.  

### Martingale Randomness 

We use Chainlink VRF as a provably-fair source of randomness for the Martingale settlement

## How to run 

```bash
# Install dependencies
npm install

# test contracts with hardhat
npx hardhat test
```

