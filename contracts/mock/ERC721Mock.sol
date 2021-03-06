// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract ERC721Mock is ERC721 {
    
    constructor(
        string memory name,
        string memory symbol
    ) ERC721(name, symbol) {}

    function mint(uint256[] memory tokenIds) public {
        for(uint i = 0; i < tokenIds.length; i++) {
            _safeMint(msg.sender, tokenIds[i]);
        }
    }
}