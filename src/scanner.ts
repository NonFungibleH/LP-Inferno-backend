import { ethers } from "ethers";
import fs from "fs";

const VAULT      = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const RPC_URL    = process.env.RPC_URL!;
const provider   = new ethers.JsonRpcProvider(RPC_URL);

const infernoAbi = JSON.parse(
  fs.readFileSync("./abis/LpInfernoABI.json", "utf8")
);
const inferno    = new ethers.Contract(VAULT, infernoAbi, provider);

// NFT position manager labels
const MANAGER_NAMES: Record<string, string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "V3",
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "V4",
  "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1": "V3_CUSTOM",
};

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)"
];

export async function scanVault() {
  const results: any[] = [];
  const fromBlock = 14_200_000; // adjust as needed

  // V2 scan (ERC20Deposited events)
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

  // V3/V4 scan (Transfer events to VAULT)
  const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

  for (const [manager, name] of Object.entries(MANAGER_NAMES)) {
    const pm = new ethers.Contract(manager, ERC721_ABI, provider);

    const logs = await provider.getLogs({
      address: manager,
      fromBlock,
      toBlock: "latest",
      topics: [
        TRANSFER_TOPIC,
        null,
        ethers.zeroPadValue(VAULT, 32),
      ],
    });

    const tokenIds = [...new Set(logs.map(log => BigInt(log.topics[3]).toString()))];

    for (const tokenId of tokenIds) {
      try {
        const owner = await pm.ownerOf(tokenId);
        if (owner.toLowerCase() !== VAULT.toLowerCase()) continue;

        const sender = await inferno.originalOwner(manager, tokenId);
        results.push({
          type: name,
          manager: manager.toLowerCase(),
          tokenId,
          sender: sender.toLowerCase(),
        });
      } catch {
        // skip missing tokenIds
      }
    }
  }

  fs.writeFileSync("data/vault.json", JSON.stringify(results, null, 2));
  console.log("Scan complete:", results.length, "records found.");
}
