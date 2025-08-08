import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// ===== Config =====
const RPC_URL = process.env.RPC_URL!;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const VAULT = (process.env.VAULT ?? "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929").toLowerCase();
const START_BLOCK = Number(process.env.START_BLOCK ?? 33201418); // vault deployment block
const CHAIN = (process.env.CHAIN ?? "base").toLowerCase();

const provider = new ethers.JsonRpcProvider(RPC_URL);

// ===== Paths =====
const vaultPath = path.resolve(process.cwd(), "data/vault.json");
const metaPath  = path.resolve(process.cwd(), "data/scanner.meta.json");

// ===== ABIs =====
const infernoAbi = JSON.parse(fs.readFileSync("./abis/LpInfernoABI.json", "utf8"));
const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];
const ERC20_ABI = ["function symbol() view returns (string)"];

const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

const MANAGER_NAMES: Record<string, string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "v3",         // Uniswap V3 main
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "v4",         // Uniswap V4 main
  "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1": "v3_custom",  // Your custom V3
};

// ===== Helpers =====
function loadJSON<T>(p: string, fallback: T): T {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {}
  return fallback;
}
function saveJSON<T>(p: string, data: T) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

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

async function chunkedManagerLogs(managerAddr: string, fromBlock: number, toBlock: number, chunkSize = 2000) {
  const logs: ethers.Log[] = [];
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const toTopic = ethers.zeroPadValue(VAULT, 32);

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const part = await provider.getLogs({
        address: managerAddr,
        fromBlock: start,
        toBlock: end,
        topics: [transferTopic, null, toTopic],
      });
      logs.push(...part);
    } catch (e: any) {
      console.warn(`⚠️ getLogs failed for ${start}-${end} on ${managerAddr}:`, e?.message ?? e);
    }
  }
  return logs;
}

// ===== Main scan =====
export async function scanVault() {
  const results: any[] = [];

  // Load existing + meta
  const existing: any[] = loadJSON<any[]>(vaultPath, []);
  const meta = loadJSON<{ lastSeenBlock?: number }>(metaPath, {});
  const lastSeen = Math.max(meta.lastSeenBlock ?? 0, START_BLOCK);
  const head = await provider.getBlockNumber();
  const fromBlock = lastSeen + 1;
  const toBlock = head;

  console.log(`🔍 Scanning ${CHAIN} from ${fromBlock} to ${toBlock}`);

  // ===== V2: from ERC20Deposited events on vault =====
  const depositFilter = inferno.filters.ERC20Deposited();
  const depositLogs = await inferno.queryFilter(depositFilter, fromBlock, toBlock);
  for (const log of depositLogs) {
    const { user, token, amount } = log.args;
    results.push({
      type: "v2",
      token0: token.toLowerCase(),
      token1: "0x4200000000000000000000000000000000000006", // WETH assumed
      pair: await resolvePairSymbol(token, "0x4200000000000000000000000000000000000006"),
      sender: user.toLowerCase(),
      txHash: log.transactionHash,
      timestamp: Number((await provider.getBlock(log.blockNumber)).timestamp),
      chain: CHAIN,
      blockNumber: log.blockNumber,
    });
  }

  // ===== V3 / V4 =====
  for (const [manager, version] of Object.entries(MANAGER_NAMES)) {
    const pm = new ethers.Contract(manager, ERC721_ABI, provider);
    const logs = await chunkedManagerLogs(manager, fromBlock, toBlock);

    const tokenIds = [...new Set(logs.map(log => BigInt(log.topics[3]).toString()))];
    for (const tokenId of tokenIds) {
      try {
        const owner = await pm.ownerOf(tokenId);
        if (owner.toLowerCase() !== VAULT) continue;

        const pos = await pm.positions(tokenId);
        const [token0, token1] = [pos.token0, pos.token1];
        const pair = await resolvePairSymbol(token0, token1);
        const sender = await inferno.burnedBy(manager, tokenId); // or originalOwner()

        results.push({
          type: version,
          manager: manager.toLowerCase(),
          tokenId,
          token0,
          token1,
          pair,
          project: "???", // optional project label
          sender: sender.toLowerCase(),
          txHash: logs.find(l => BigInt(l.topics[3]).toString() === tokenId)?.transactionHash ?? "",
          timestamp: Number((await provider.getBlock(
            logs.find(l => BigInt(l.topics[3]).toString() === tokenId)?.blockNumber ?? 0
          )).timestamp),
          chain: CHAIN,
          blockNumber: logs.find(l => BigInt(l.topics[3]).toString() === tokenId)?.blockNumber ?? 0,
        });
      } catch {
        // skip invalid tokenIds
      }
    }
  }

  // Merge + save
  const merged = [...existing, ...results];
  saveJSON(vaultPath, merged);
  saveJSON(metaPath, { lastSeenBlock: toBlock });

  console.log(`✅ Added ${results.length} new entries. Total: ${merged.length}`);
}

// Run directly
if (require.main === module) {
  scanVault().catch(console.error);
}
