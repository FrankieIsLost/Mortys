require("@nomiclabs/hardhat-waffle");
require("@nomiclabs/hardhat-solhint");


module.exports = {
  solidity: {
    compilers: [
        {
            version: "0.6.6"
        },
        {
            version: "0.4.24"
        },
        {
            version: "0.8.4"
        }
    ]
  }
};
