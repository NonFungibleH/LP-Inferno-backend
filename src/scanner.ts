import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

const VAULT_ADDRESS = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const START_BLOCK = 33201418;
const CHUNK_SIZE = 2000;
const CHAIN = "base";

const LpInfernoABI = JSON.parse(
  fs.readFileSync("./abis/LpInfernoABI.json", "utf8")
);
const vault = new ethers.Contract(VAULT_ADDRESS, LpInfernoABI, provider);

const MANAGER_NAMES: Record<string, string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "v3",
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "v4",
  "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1": "v3",
};

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96,address,address token0,address token1,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
];
const ERC20_ABI = ["function symbol() view returns (string)"];

async function getSymbol(tokenAddress: string) {
  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await tokenContract.symbol();
  } catch {
    return "???";
  }
}

async function getPair(token0: string, token1: string) {
  const [sym0, sym1] = await Promise.all([
    getSymbol(token0),
    getSymbol(token1)
  ]);
  return `${sym0}/${sym1}`;
}

async function scan() {
  const results: any[] = [];
  const latestBlock = await provider.getBlockNumber();

  console.log(`Scanning ${CHAIN} from ${START_BLOCK} to ${latestBlock} in chunks of ${CHUNK_SIZE}`);

  // ERC20 Deposits
  const depositFilter = vault.filters.ERC20Deposited();
  for (let from = START_BLOCK; from <= latestBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);
    const logs = await vault.queryFilter(depositFilter, from, to);
    for (const log of logs) {
      const { user, token } = log.args as any;
      results.push({
        type: "v2",
        tokenId: null,
        token0: token,
        token1: "0x4200000000000000000000000000000000000006",
        pair: await getPair(token, "0x4200000000000000000000000000000000000006"),
        sender: user,
        chain: CHAIN
      });
    }
  }

  // NFT Burns
  const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

  for (const [manager, version] of Object.entries(MANAGER_NAMES)) {
    const pm = new ethers.Contract(manager, ERC721_ABI, provider);

    for (let from = START_BLOCK; from <= latestBlock; from += CHUNK_SIZE) {
      const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);
      const logs = await provider.getLogs({
        address: manager,
        fromBlock: from,
        toBlock: to,
        topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(VAULT_ADDRESS, 32)],
      });

      const tokenIds = [...new Set(logs.map(l => BigInt(l.topics[3]).toString()))];
      for (const tokenId of tokenIds) {
        try {
          const owner = await pm.ownerOf(tokenId);
          if (owner.toLowerCase() !== VAULT_ADDRESS.toLowerCase()) continue;
          const pos = await pm.positions(tokenId);
          results.push({
            type: version,
            tokenId,
            token0: pos.token0,
            token1: pos.token1,
            pair: await getPair(pos.token0, pos.token1),
            sender: await vault.burnedBy(manager, tokenId),
            chain: CHAIN
          });
        } catch {}
      }
    }
  }

  const filePath = path.join("data", "vault.json");
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
  console.log(`Saved ${results.length} records`);
}

scan().catch(console.error);
