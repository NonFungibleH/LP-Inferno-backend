import { ethers } from "ethers";
import fs from "fs";

const VAULT      = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929"; // your new LPInferno
const RPC_URL    = process.env.RPC_URL!;
const provider   = new ethers.JsonRpcProvider(RPC_URL);

// load your updated ABI locally (make sure it's pushed!)
const infernoAbi = JSON.parse(
  fs.readFileSync("./abis/LpInfernoABI.json", "utf8")
);
const inferno    = new ethers.Contract(VAULT, infernoAbi, provider);

// names for NFT managers
const MANAGER_NAMES: Record<string,string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "V3",
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "V4",
  "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1": "V3_CUSTOM",
};

// minimal ERC-721 ABI for ownerOf
const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)"
];

export async function scanVault() {
  const results: any[] = [];
  const fromBlock = 14_200_000; // your new deployment block

  // — V2: ERC20Deposited events ——
  const depositFilter = inferno.filters.ERC20Deposited();
  const depositLogs   = await inferno.queryFilter(depositFilter, fromBlock, "latest");
  for (const log of depositLogs) {
    const { user, token, amount } = inferno.interface.parseLog(log).args;
    results.push({
      type:   "V2",
      token:  token.toLowerCase(),
      amount: amount.toString(),
      sender: user.toLowerCase(),
      tx:     log.transactionHash,
      block:  log.blockNumber,
    });
  }

  // — V3/V4: NFT burns via ownerOf & originalOwner ——
  for (const [address, name] of Object.entries(MANAGER_NAMES)) {
    const pm = new ethers.Contract(address, ERC721_ABI, provider);
    for (let id = 1; id <= 2000; id++) {
      try {
        const owner = await pm.ownerOf(id);
        if (owner.toLowerCase() !== VAULT.toLowerCase()) continue;
        const sender = await inferno.originalOwner(address, id);
        results.push({
          type:    name,
          manager: address.toLowerCase(),
          tokenId: id.toString(),
          sender:  sender.toLowerCase(),
        });
      } catch {
        // no such tokenId
      }
    }
  }

  fs.writeFileSync("data/vault.json", JSON.stringify(results, null, 2));
  console.log("Scan complete:", results.length, "records found.");
}
