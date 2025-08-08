import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import PositionManagerABI from "../abis/UniswapV3PositionManager.json";
import { resolvePair } from "./pairResolver";

dotenv.config();

// ===== Config =====
const BASE_RPC = process.env.BASE_RPC!;
if (!BASE_RPC) throw new Error("Missing BASE_RPC env var");

const CHAIN = (process.env.CHAIN ?? "base").toLowerCase();
const VAULT = (process.env.VAULT ?? "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929").toLowerCase();

// Uniswap managers on Base
const V3_MANAGER = (process.env.V3_MANAGER ?? "0x03a520b32c04bf3beef7beb72e919cf822ed34f1").toLowerCase();
const V4_MANAGER = (process.env.V4_MANAGER ?? "0x7C5f5A4bBd8fD63184577525326123B519429bDc").toLowerCase();

// Start from your deployment block
const START_BLOCK = Number(process.env.START_BLOCK ?? 33201418);

// Chunk sizes (more conservative to avoid RPC limits)
const CHUNK_ERC721 = 2_000;
const CHUNK_ERC20  = 2_000;

const provider = new ethers.JsonRpcProvider(BASE_RPC);

// ===== File paths (repo root) =====
const vaultPath = path.resolve(process.cwd(), "data/vault.json");
const metaPath  = path.resolve(process.cwd(), "data/scanner.meta.json");

// ===== Minimal ABIs =====
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

type VaultRow = {
  type: "v2" | "v3" | "v4";
  // v3/v4
  tokenId?: string;
  manager?: string;
  // v2
  pairAddress?: string;
  // shared/enriched
  token0: string;
  token1: string;
  pair: string;
  project?: string;
  sender: string;
  txHash: string;
  timestamp: number;
  chain: string;
  blockNumber: number;
};

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

function toTopicAddr(addr: string) {
  return ethers.zeroPadValue(addr, 32);
}

async function getBlockTimestamp(blockNumber: number): Promise<number> {
  const b = await provider.getBlock(blockNumber);
  return Number(b?.timestamp ?? 0);
}

async function chunkedGetLogs(params: {
  address?: string | string[];
  topics?: (string | string[] | null)[];
  fromBlock: number;
  toBlock: number;
  chunk: number;
}) {
  const { address, topics, chunk } = params;
  const logs: ethers.Log[] = [];
  let { fromBlock, toBlock } = params;

  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const part = await provider.getLogs({
        address,
        fromBlock: start,
        toBlock: end,
        topics,
      });
      logs.push(...part);
    } catch (e: any) {
      console.warn(`⚠️ getLogs failed for ${start}-${end}:`, e?.message ?? e);
    }
  }
  return logs;
}

async function scanERC721TransfersToVault(
  managerAddr: string,
  fromBlock: number,
  toBlock: number
) {
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const toTopic = toTopicAddr(VAULT);
  return chunkedGetLogs({
    address: managerAddr,
    topics: [transferTopic, null, toTopic],
    fromBlock,
    toBlock,
    chunk: CHUNK_ERC721,
  });
}

async function scanERC20TransfersToVault(fromBlock: number, toBlock: number) {
  // wildcard address; filter later by checking token0/token1
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const toTopic = toTopicAddr(VAULT);
  return chunkedGetLogs({
    topics: [transferTopic, null, toTopic],
    fromBlock,
    toBlock,
    chunk: CHUNK_ERC20,
  });
}

function hasRow(rows: VaultRow[], pred: (r: VaultRow) => boolean) {
  return rows.some(pred);
}

async function enrichV3orV4(
  rows: VaultRow[],
  manager: string,
  type: "v3" | "v4"
) {
  const pm = new ethers.Contract(manager, PositionManagerABI, provider);
  for (const row of rows) {
    if (row.type !== type || !row.tokenId) continue;
    try {
      const pos = await pm.positions(BigInt(row.tokenId));
      const token0 = (pos as any).token0 ?? (pos as any)[2];
      const token1 = (pos as any).token1 ?? (pos as any)[3];

      if (ethers.isAddress(token0) && ethers.isAddress(token1)) {
        row.token0 = ethers.getAddress(token0);
        row.token1 = ethers.getAddress(token1);
        row.pair = (await resolvePair(row.token0, row.token1, provider)) || "";
      }
    } catch (e) {
      console.warn(`❌ positions() failed for ${type} ${row.tokenId}:`, e);
    }
  }
}

async function tryDetectV2Pair(addr: string): Promise<{ token0?: string; token1?: string }> {
  try {
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
    if (ethers.isAddress(t0) && ethers.isAddress(t1)) {
      return { token0: ethers.getAddress(t0), token1: ethers.getAddress(t1) };
    }
  } catch {
    // not a V2 pair (no token0/token1)
  }
  return {};
}

async function scanVault() {
  // Load existing data + meta
  const existing: VaultRow[] = loadJSON<VaultRow[]>(vaultPath, []);
  const meta = loadJSON<{ lastSeenBlock?: number }>(metaPath, {});
  const lastSeenData = existing.reduce((m, e) => Math.max(m, e.blockNumber ?? 0), 0);

  const head = await provider.getBlockNumber();
  const fromBlock = Math.max(START_BLOCK, meta.lastSeenBlock ?? lastSeenData ?? START_BLOCK) + 1;
  const toBlock = head;

  if (toBlock < fromBlock) {
    console.log(`Nothing to scan. lastSeen=${fromBlock - 1}, head=${toBlock}`);
    return;
  }

  console.log(`🔎 Scanning ${fromBlock} → ${toBlock} on ${CHAIN}`);

  // --- V3 + V4 (ERC-721) ---
  const [v3Logs, v4Logs] = await Promise.all([
    scanERC721TransfersToVault(V3_MANAGER, fromBlock, toBlock),
    scanERC721TransfersToVault(V4_MANAGER, fromBlock, toBlock),
  ]);
  console.log(`📬 V3 logs: ${v3Logs.length}, V4 logs: ${v4Logs.length}`);

  const iface721 = new ethers.Interface(PositionManagerABI);
  const newV3: VaultRow[] = [];
  const newV4: VaultRow[] = [];

  for (const log of v3Logs) {
    try {
      const { args } = iface721.parseLog(log)!; // [from, to, tokenId]
      const from = (args[0] as string).toLowerCase();
      const tokenId = args[2].toString();
      const blockNumber = log.blockNumber;
      const timestamp = await getBlockTimestamp(blockNumber);

      if (
        hasRow(existing, r =>
          r.type === "v3" &&
          r.tokenId === tokenId &&
          r.manager?.toLowerCase() === V3_MANAGER
        )
      ) continue;

      newV3.push({
        type: "v3",
        tokenId,
        manager: ethers.getAddress(V3_MANAGER),
        token0: ethers.ZeroAddress,
        token1: ethers.ZeroAddress,
        pair: "",
        sender: ethers.getAddress(from),
        txHash: log.transactionHash,
        timestamp,
        chain: CHAIN,
        blockNumber,
      });
    } catch (e) {
      console.warn("⚠️ parse v3 log failed:", e);
    }
  }

  for (const log of v4Logs) {
    try {
      const { args } = iface721.parseLog(log)!;
      const from = (args[0] as string).toLowerCase();
      const tokenId = args[2].toString();
      const blockNumber = log.blockNumber;
      const timestamp = await getBlockTimestamp(blockNumber);

      if (
        hasRow(existing, r =>
          r.type === "v4" &&
          r.tokenId === tokenId &&
          r.manager?.toLowerCase() === V4_MANAGER
        )
      ) continue;

      newV4.push({
        type: "v4",
        tokenId,
        manager: ethers.getAddress(V4_MANAGER),
        token0: ethers.ZeroAddress,
        token1: ethers.ZeroAddress,
        pair: "",
        sender: ethers.getAddress(from),
        txHash: log.transactionHash,
        timestamp,
        chain: CHAIN,
        blockNumber,
      });
    } catch (e) {
      console.warn("⚠️ parse v4 log failed:", e);
    }
  }

  // --- V2 (ERC-20 LPs) ---
  const erc20Logs = await scanERC20TransfersToVault(fromBlock, toBlock);
  console.log(`📬 ERC-20 logs to vault: ${erc20Logs.length}`);

  const newV2: VaultRow[] = [];
  const byToken = new Map<string, ethers.Log[]>();
  for (const log of erc20Logs) {
    const token = (log.address as string).toLowerCase();
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token)!.push(log);
  }

  for (const [tokenAddr, logs] of byToken) {
    const { token0, token1 } = await tryDetectV2Pair(tokenAddr);
    if (!token0 || !token1) continue; // not a V2 LP

    const pairLabel = (await resolvePair(token0, token1, provider)) || "";

    for (const log of logs) {
      const blockNumber = log.blockNumber;
      const timestamp = await getBlockTimestamp(blockNumber);
      // topics[1] = from (padded)
      const fromPadded = log.topics[1];
      const from = ethers.getAddress("0x" + fromPadded.slice(26));

      // dedupe by (pairAddress, txHash)
      if (
        hasRow(existing, r =>
          r.type === "v2" &&
          r.pairAddress?.toLowerCase() === tokenAddr &&
          r.txHash === log.transactionHash
        )
      ) continue;

      newV2.push({
        type: "v2",
        pairAddress: ethers.getAddress(tokenAddr),
        token0,
        token1,
        pair: pairLabel,
        sender: from,
        txHash: log.transactionHash,
        timestamp,
        chain: CHAIN,
        blockNumber,
      });
    }
  }

  // Merge + enrich
  const merged = [...existing, ...newV2, ...newV3, ...newV4];

  await enrichV3orV4(merged, V3_MANAGER, "v3");
  await enrichV3orV4(merged, V4_MANAGER, "v4");

  // Persist (only after successful enrichment)
  saveJSON(vaultPath, merged);
  saveJSON(metaPath, { lastSeenBlock: toBlock });

  console.log(
    `✅ Added V2=${newV2.length}, V3=${newV3.length}, V4=${newV4.length}. Total rows: ${merged.length}`
  );
}

scanVault().catch((err) => {
  console.error("❌ Scanner error:", err);
  process.exitCode = 1;
});
