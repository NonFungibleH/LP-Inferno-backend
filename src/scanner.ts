import { ethers } from "ethers";
import fs from "fs";

// --- CONFIG ---
const VAULT = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const RPC_URL = process.env.RPC_URL!;
const CHAIN = "base";
const START_BLOCK = 33200000; // adjust as needed
const CHUNK_SIZE = 2000; // keeps RPC happy

const provider = new ethers.JsonRpcProvider(RPC_URL);

// --- ABIs ---
const infernoAbi = JSON.parse(fs.readFileSync("./abis/LpInfernoABI.json", "utf8"));
const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

const MANAGER_NAMES: Record<string, string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "V3",
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "V4",
};

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const ERC20_ABI = ["function symbol() view returns (string)"];

// --- Helpers ---
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

// --- Scanner ---
export async function scanVault() {
  const results: any[] = [];
  const latestBlock = await provider.getBlockNumber();

  console.log(`🔍 Scanning ${CHAIN} from ${START_BLOCK} to ${latestBlock}`);

  // --- V2 Deposits ---
  const depositFilter = inferno.filters.ERC20Deposited();

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
        token1: "0x4200000000000000000000000000000000000006", // WETH
        pair: await resolvePairSymbol(token, "0x4200000000000000000000000000000000000006"),
        project: "???",
        sender: user.toLowerCase(),
        txHash: log.transactionHash,
        timestamp: (await provider.getBlock(log.blockNumber)).timestamp,
        chain: CHAIN,
      });
    }
  }

  // --- V3 & V4 NFT Burns ---
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

      const tokenIds = [...new Set(logs.map((log) => BigInt(log.topics[3]).toString()))];

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
            txHash: null,
            timestamp: null,
            chain: CHAIN,
          });
        } catch {
          // skip
        }
      }
    }
  }

  // --- Save to file ---
  fs.writeFileSync("./data/vault.json", JSON.stringify(results, null, 2));
  console.log(`✅ Saved ${results.length} entries to data/vault.json`);
}

// --- Run ---
scanVault().catch(console.error);
