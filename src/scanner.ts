import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import PositionManagerABI from "../abis/UniswapV3PositionManager.json";
import { resolvePair } from "./pairResolver";

dotenv.config();

const BASE_RPC = process.env.BASE_RPC!;
if (!BASE_RPC) throw new Error("Missing BASE_RPC env var");

const provider = new ethers.JsonRpcProvider(BASE_RPC);

// 🔐 YOUR VAULT (burn) ADDRESS
const VAULT_ADDR = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";

// 🧰 Uniswap V4 Position Manager (Base)
const V4_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
const manager = new ethers.Contract(V4_MANAGER, PositionManagerABI, provider);

// 📦 File paths (repo-root stable)
const vaultPath = path.resolve(process.cwd(), "data/vault.json");
const metaPath = path.resolve(process.cwd(), "data/scanner.meta.json");

// 🧱 Optional start block (first deployment block or earlier)
const DEFAULT_START_BLOCK = Number(process.env.START_BLOCK ?? 0);

type VaultRow = {
  type: "v4" | "v3" | "v2";
  tokenId: string;
  token0: string;
  token1: string;
  pair: string;
  blockNumber?: number;
  txHash?: string;
  chain?: string;
};

// --- helpers ---
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

// --- main scan ---
async function scanVault() {
  // 1) Load current data + meta
  const current: VaultRow[] = loadJSON<VaultRow[]>(vaultPath, []);
  const meta = loadJSON<{ lastSeenBlock?: number }>(metaPath, {});

  const lastSeenBlockFromData = current.reduce(
    (m, e) => Math.max(m, e.blockNumber ?? 0),
    0
  );
  const fromBlock = Math.max(
    DEFAULT_START_BLOCK,
    meta.lastSeenBlock ?? lastSeenBlockFromData
  );
  const toBlock = await provider.getBlockNumber();

  console.log(
    `🔎 Scanning Transfer(to=${VAULT_ADDR}) on V4 PM from block ${fromBlock + 1} to ${toBlock} …`
  );

  // 2) ERC-721 Transfer(address,address,uint256)
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const toTopic = ethers.zeroPadValue(VAULT_ADDR, 32);

  let logs: ethers.Log[] = [];
  if (toBlock > fromBlock) {
    // chunk requests if the range is large (keeps RPC happy)
    const CHUNK = 20_000;
    for (let start = fromBlock + 1; start <= toBlock; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, toBlock);
      try {
        const part = await provider.getLogs({
          address: V4_MANAGER,
          fromBlock: start,
          toBlock: end,
          topics: [transferTopic, null, toTopic],
        });
        logs.push(...part);
      } catch (e) {
        console.warn(`⚠️ getLogs failed for ${start}-${end}:`, e);
      }
    }
  }

  console.log(`📬 Found ${logs.length} new transfer logs to vault.`);

  // 3) Decode logs → new entries
  const iface = new ethers.Interface(PositionManagerABI);
  const newEntries: VaultRow[] = [];

  for (const log of logs) {
    const { args } = iface.parseLog(log)!; // [from, to, tokenId]
    const tokenId = args[2].toString();

    // skip if already known
    if (current.some((e) => e.type === "v4" && e.tokenId === tokenId)) continue;

    newEntries.push({
      type: "v4",
      tokenId,
      token0: ethers.ZeroAddress,
      token1: ethers.ZeroAddress,
      pair: "",
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      chain: "base",
    });
  }

  // 4) Merge (dedupe)
  const merged = [...current, ...newEntries];

  // 5) Enrich missing token0/token1 for v4 entries
  const enriched = await Promise.all(
    merged.map(async (entry) => {
      if (
        entry.type === "v4" &&
        entry.token0 === ethers.ZeroAddress &&
        entry.token1 === ethers.ZeroAddress
      ) {
        try {
          const pos = await manager.positions(BigInt(entry.tokenId));
          const token0Addr = (pos as any).token0 ?? (pos as any)[2];
          const token1Addr = (pos as any).token1 ?? (pos as any)[3];

          if (token0Addr && token1Addr) {
            entry.token0 = token0Addr;
            entry.token1 = token1Addr;
            entry.pair = await resolvePair(token0Addr, token1Addr, provider);
            console.log(
              `✅ ${entry.tokenId}: ${entry.pair || `${token0Addr}/${token1Addr}`}`
            );
          } else {
            console.warn(`⚠️ ${entry.tokenId}: positions() returned empty tokens`);
          }
        } catch (e) {
          console.warn(`❌ positions() failed for ${entry.tokenId}:`, e);
        }
      }
      return entry;
    })
  );

  // 6) Persist
  saveJSON(vaultPath, enriched);

  // 7) Update meta
  saveJSON(metaPath, { lastSeenBlock: toBlock });

  console.log(
    `✅ Added ${newEntries.length} new positions; total rows: ${enriched.length}.`
  );
}

scanVault().catch((err) => {
  console.error("❌ Scanner error:", err);
  process.exitCode = 1;
});
