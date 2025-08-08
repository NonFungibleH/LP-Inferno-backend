// src/index.ts
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

const VAULT = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const START_BLOCK = 33201418; // Vault deploy block
const CHUNK_SIZE = 2000; // Keeps block ranges small to avoid RPC errors
const CHAIN = "base";

const infernoAbi = JSON.parse(
  fs.readFileSync("./abis/LpInfernoABI.json", "utf8")
);
const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

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

async function resolvePairSymbol(token0: string, token1: string): Promise<string> {
  try {
    const [c0, c1] = [
      new ethers.Contract(token0, ERC20_ABI, provider),
      new ethers.Contract(token1, ERC20_ABI, provider),
    ];
    const [sym0, sym1] = await Promise.all([c0.symbol(), c1.symbol()]);
    return `${sym0}/${sym1}`;
  } catch {
    return "???/???";
  }
}

async function scanVault() {
  const results: any[] = [];

  // ---- Scan V2 Deposits ----
  const depositFilter = inferno.filters.ERC20Deposited();
  const latestBlock = await provider.getBlockNumber();

  for (let from = START_BLOCK; from <= latestBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);
    const depositLogs = await inferno.queryFilter(depositFilter, from, to);

    for (const log of depositLogs) {
      const { user, token } = log.args as any;
      results.push({
        type: "v2",
        tokenId: null,
        manager: null,
        token0: token.toLowerCase(),
        token1: "0x4200000000000000000000000000000000000006", // assume WETH
        pair: await resolvePairSymbol(token, "0x4200000000000000000000000000000000000006"),
        project: "???",
        sender: user.toLowerCase(),
        txHash: log.transactionHash,
        timestamp: (await provider.getBlock(log.blockNumber)).timestamp,
        chain: CHAIN,
      });
    }
  }

  // ---- Scan V3 / V4 Burns ----
  const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

  for (const [manager, version] of Object.entries(MANAGER_NAMES)) {
    const pm = new ethers.Contract(manager, ERC721_ABI, provider);

    for (let from = START_BLOCK; from <= latestBlock; from += CHUNK_SIZE) {
      const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);

      const logs = await provider.getLogs({
        address: manager,
        fromBlock: from,
        toBlock: to,
        topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(VAULT, 32)],
      });

      const tokenIds = [...new Set(logs.map(log => BigInt(log.topics[3]).toString()))];

      for (const tokenId of tokenIds) {
        try {
          const owner = await pm.ownerOf(tokenId);
          if (owner.toLowerCase() !== VAULT.toLowerCase()) continue;

          const pos = await pm.positions(tokenId);
          const [token0, token1] = [pos.token0, pos.token1];
          const pair = await resolvePairSymbol(token0, token1);
          const sender = await inferno.burnedBy(manager, tokenId);

          results.push({
            type: version,
            tokenId,
            manager: manager.toLowerCase(),
            token0,
            token1,
            pair,
            project: "???",
            sender: sender.toLowerCase(),
            txHash: logs.find(l => BigInt(l.topics[3]).toString() === tokenId)?.transactionHash || "",
            timestamp: (await provider.getBlock(logs[0].blockNumber)).timestamp,
            chain: CHAIN,
          });
        } catch {
          // skip errors for invalid tokenIds
        }
      }
    }
  }

  // ---- Save to vault.json ----
  const filePath = path.join("data", "vault.json");
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
  console.log(`✅ Saved ${results.length} records to ${filePath}`);
}

scanVault().catch(console.error);
