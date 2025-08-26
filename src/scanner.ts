// scranner.ts
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

const VAULT = "0x37307B774598E5DB1887624Bafbfe4ACdf693b5D";
const START_BLOCK = 33201418; // Vault deploy block
const CHUNK_SIZE = 2000; // Small block chunks to avoid RPC limit
const CHAIN = "base";

// --- ABIs ---
const infernoAbi = JSON.parse(fs.readFileSync("./abis/LpInfernoABI.json", "utf8"));
const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

const MANAGER_NAMES: Record<string, string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "v3", // Uniswap V3 PM
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "v4", // Uniswap V4 PM
  "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1": "v3",
};

// V3 position manager (ownerOf + positions with token0/token1)
const V3_PM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96,address,address token0,address token1,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
];

// V4 position manager (ownerOf only here; positions is separate ABIs below)
const ERC721_OWNER_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)"
];

// Two common shapes for V4 positions()
const V4_PM_ABI_A = [
  "function positions(uint256) view returns (address owner, bytes32 poolId, int24, int24, uint128, uint256, uint256, uint256, uint256)"
];
const V4_PM_ABI_B = [
  "function positions(uint256) view returns (address owner, bytes32 poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint160 feeGrowthInside0LastX128, uint160 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];

const V4_POOLMANAGER_ABI = [
  "function pools(bytes32) view returns (address currency0, address currency1, uint24 fee, address hooks, int24 tickSpacing, uint8 unlocked, uint8 protocolFee, uint8 lpFee)"
];

// Fallback Base PoolManager (you recorded this earlier)
const BASE_V4_POOL_MANAGER = "0x1631559198a9e474033433b2958dabc135ab6446";

// --- symbol helpers ---
const SYMBOL_ABI_STRING  = ["function symbol() view returns (string)"];
const SYMBOL_ABI_BYTES32 = ["function symbol() view returns (bytes32)"];
const NAME_ABI_STRING    = ["function name() view returns (string)"];
const NAME_ABI_BYTES32   = ["function name() view returns (bytes32)"];

const symbolCache = new Map<string, string>();

function cleanBytes32ToString(b: string): string {
  try { return ethers.decodeBytes32String(b); } catch {
    try {
      const raw = ethers.hexlify(b);
      const bytes = ethers.getBytes(raw);
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end--;
      const trimmed = new Uint8Array(bytes.slice(0, end));
      return new TextDecoder().decode(trimmed);
    } catch { return ""; }
  }
}

async function trySymbol(addr: string) {
  try { return await new ethers.Contract(addr, SYMBOL_ABI_STRING, provider).symbol(); } catch {}
  try {
    const bytes: string = await new ethers.Contract(addr, SYMBOL_ABI_BYTES32, provider).symbol();
    const s = cleanBytes32ToString(bytes);
    if (s) return s;
  } catch {}
  return null;
}

async function tryName(addr: string) {
  try { return await new ethers.Contract(addr, NAME_ABI_STRING, provider).name(); } catch {}
  try {
    const bytes: string = await new ethers.Contract(addr, NAME_ABI_BYTES32, provider).name();
    const n = cleanBytes32ToString(bytes);
    if (n) return n;
  } catch {}
  return null;
}

async function fetchTokenSymbol(address: string) {
  const addr = address?.toLowerCase?.() ?? address;
  if (!addr || addr === ethers.ZeroAddress) return "???";
  if (symbolCache.has(addr)) return symbolCache.get(addr)!;

  let sym = await trySymbol(addr);
  if (!sym || sym.length > 32) {
    const name = await tryName(addr);
    if (name && name.length <= 12) sym = name;
  }

  if (!sym || !/^[\x20-\x7E]+$/.test(sym)) sym = "???";
  symbolCache.set(addr, sym);
  return sym;
}

async function resolvePairSymbol(token0: string, token1: string): Promise<string> {
  try {
    const [sym0, sym1] = await Promise.all([fetchTokenSymbol(token0), fetchTokenSymbol(token1)]);
    return `${sym0}/${sym1}`;
  } catch {
    return "???/???";
  }
}

// --- helpers ---
async function getPoolManagerAddr(pmAddr: string): Promise<string> {
  const tryABIs = [
    ["function manager() view returns (address)", "manager"],
    ["function poolManager() view returns (address)", "poolManager"]
  ] as const;

  for (const [sig, fn] of tryABIs) {
    try {
      const c = new ethers.Contract(pmAddr, [sig], provider);
      const addr: string = await (c as any)[fn]();
      if (ethers.isAddress(addr)) return addr;
    } catch {}
  }
  return BASE_V4_POOL_MANAGER;
}

async function resolveV4Tokens(manager: string, tokenId: string): Promise<[string, string]> {
  let pos: any;
  try {
    const pmA = new ethers.Contract(manager, V4_PM_ABI_A, provider);
    pos = await pmA.positions(tokenId);
  } catch {
    const pmB = new ethers.Contract(manager, V4_PM_ABI_B, provider);
    pos = await pmB.positions(tokenId);
  }

  const poolId: string | undefined = pos?.poolId ?? pos?.[1];
  if (!poolId || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) {
    throw new Error(`V4 positions() returned unexpected shape for tokenId ${tokenId}`);
  }

  const poolManagerAddr = await getPoolManagerAddr(manager);
  const poolMgr = new ethers.Contract(poolManagerAddr, V4_POOLMANAGER_ABI, provider);
  const pool: any = await poolMgr.pools(poolId);

  const token0: string | undefined = pool?.currency0 ?? pool?.[0];
  const token1: string | undefined = pool?.currency1 ?? pool?.[1];

  if (!token0 || !ethers.isAddress(token0) || !token1 || !ethers.isAddress(token1)) {
    throw new Error(`Invalid currencies from PoolManager.pools(${poolId})`);
  }
  return [token0, token1];
}

async function scanVault() {
  const results: any[] = [];
  const latestBlock = await provider.getBlockNumber();

  console.log(`🔍 Scanning ${CHAIN} from ${START_BLOCK} to ${latestBlock} in chunks of ${CHUNK_SIZE} blocks`);

  // ---- Scan V2 Deposits ----
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
        token1: "0x4200000000000000000000000000000000000006", // Base WETH
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
    // ownerOf only (works for both v3 & v4)
    const pmOwner = new ethers.Contract(manager, ERC721_OWNER_ABI, provider);
    // v3 positions reader
    const pmV3 = version === "v3" ? new ethers.Contract(manager, V3_PM_ABI, provider) : null;

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
          const owner = await pmOwner.ownerOf(tokenId);
          if (owner.toLowerCase() !== VAULT.toLowerCase()) continue;

          // use the log corresponding to this tokenId for tx/block
          const logForToken = logs.find(l => BigInt(l.topics[3]).toString() === tokenId);
          if (!logForToken) continue;

          let token0: string, token1: string;

          if (version === "v4") {
            [token0, token1] = await resolveV4Tokens(manager, tokenId);
          } else {
            const pos = await pmV3!.positions(tokenId);
            token0 = pos.token0 as string;
            token1 = pos.token1 as string;
          }

          const pair = await resolvePairSymbol(token0, token1);
          const sender = await inferno.burnedBy(manager, tokenId);
          const blockTimestamp = (await provider.getBlock(logForToken.blockNumber)).timestamp;

          results.push({
            type: version,
            tokenId,
            manager: manager.toLowerCase(),
            token0,
            token1,
            pair,
            project: "???",
            sender: (sender as string).toLowerCase(),
            txHash: logForToken.transactionHash,
            timestamp: blockTimestamp,
            chain: CHAIN,
          });
        } catch {
          // skip errors per tokenId
        }
      }
    }
  }

  // ---- Save to vault.json ----
  const filePath = path.join("public", "data", "vault.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
  console.log(`✅ Saved ${results.length} records to ${filePath}`);
}

scanVault().catch((e) => {
  console.error(e);
  process.exit(1);
});
