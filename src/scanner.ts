// src/index.ts
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const RPC_URL = process.env.RPC_URL!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

const VAULT = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const START_BLOCK = 33201418; // Vault deploy block
const CHUNK_SIZE = 2000; // Small block chunks to avoid RPC limit
const CHAIN = "base";

const infernoAbi = JSON.parse(
  fs.readFileSync("./abis/LpInfernoABI.json", "utf8")
);
const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

// Note: the Base v3 manager is 0x03a520..., the 0xC364... address is mainnet v3.
// Keeping both here won't hurt (Base RPC will just return no logs for mainnet addr).
const MANAGER_NAMES: Record<string, "v3" | "v4"> = {
  "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1": "v3", // Base v3
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "v4", // Base v4
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "v3", // Mainnet v3 (likely no logs on Base)
};

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  // we won't rely on a single positions signature—see readTokensFromPositions()
];
const ERC20_ABI = ["function symbol() view returns (string)"];

/** Resolve pair symbols (best-effort). */
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

/**
 * Try to read token0/token1 from positions() with multiple shapes (V3 vs V4).
 * Falls back to index access if named fields aren't present.
 */
async function readTokensFromPositions(
  manager: string,
  tokenId: string
): Promise<{ token0?: string; token1?: string }> {
  // Try several positions() ABIs commonly seen on V3/V4
  const candidateAbis = [
    // V3-style (named token0/token1)
    "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
    // Another V3-style ordering (index fallback will still work)
    "function positions(uint256) view returns (address,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
    // V4-like (currency0/currency1)
    "function positions(uint256) view returns (address owner, address currency0, address currency1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 tokensOwed0, uint256 tokensOwed1)"
  ];

  for (const sig of candidateAbis) {
    try {
      const pm = new ethers.Contract(manager, [sig], provider);
      const pos: any = await pm.positions(tokenId);

      // Try named fields first, then index fallback
      const t0 = pos.token0 ?? pos.currency0 ?? pos[2];
      const t1 = pos.token1 ?? pos.currency1 ?? pos[3];

      if (ethers.isAddress(t0) && ethers.isAddress(t1)) {
        return { token0: ethers.getAddress(t0), token1: ethers.getAddress(t1) };
      }
    } catch {
      // try next signature
    }
  }
  return {};
}

/**
 * Fallback for V4 (or when positions() doesn't expose tokens):
 * read token0/token1 from your vault's FeesClaimed event that includes them.
 * Scans a recent window to stay cheap.
 */
async function readTokensFromVaultEvents(
  tokenId: string,
  manager: string,
  endBlock: number
): Promise<{ token0?: string; token1?: string }> {
  const topic = ethers.id(
    "FeesClaimed(address,address,uint256,address,address,uint256,uint256)"
  );
  const fromBlock = Math.max(START_BLOCK, endBlock - 20_000); // ~safe window

  try {
    const logs = await provider.getLogs({
      address: VAULT,
      fromBlock,
      toBlock: endBlock,
      topics: [topic],
    });

    for (const log of logs) {
      // data: user, nftAddr, tokenId, token0, token1, amount0, amount1
      const [ , nftAddr, tid, t0, t1 ] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address","address","uint256","address","address","uint256","uint256"],
        log.data
      );
      if (
        tid.toString() === tokenId &&
        String(nftAddr).toLowerCase() === manager.toLowerCase()
      ) {
        if (ethers.isAddress(t0) && ethers.isAddress(t1)) {
          return {
            token0: ethers.getAddress(t0),
            token1: ethers.getAddress(t1),
          };
        }
      }
    }
  } catch {
    // ignore
  }
  return {};
}

async function scanVault() {
  const results: any[] = [];
  const latestBlock = await provider.getBlockNumber();

  console.log(`🔍 Scanning ${CHAIN} from ${START_BLOCK} to ${latestBlock} in chunks of ${CHUNK_SIZE} blocks`);

  // ---- Scan V2 Deposits (unchanged) ----
  const depositFilter = inferno.filters.ERC20Deposited();
  for (let from = START_BLOCK; from <= latestBlock; from += CHUNK_SIZE) {
    const to = Math.min(from + CHUNK_SIZE - 1, latestBlock);
    let depositLogs: ethers.Log[] = [];
    try {
      depositLogs = await inferno.queryFilter(depositFilter, from, to);
    } catch (e) {
      console.warn(`⚠️ deposit queryFilter failed for ${from}-${to}`, e);
      continue;
    }

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
        sender: String(user).toLowerCase(),
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

      let logs: ethers.Log[] = [];
      try {
        logs = await provider.getLogs({
          address: manager,
          fromBlock: from,
          toBlock: to,
          topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(VAULT, 32)],
        });
      } catch (e) {
        console.warn(`⚠️ getLogs failed for ${manager} ${from}-${to}`, e);
        continue;
      }

      // Unique tokenIds that moved to the vault in this window
      const tokenIds = [...new Set(logs.map(log => BigInt(log.topics[3]).toString()))];

      for (const tokenId of tokenIds) {
        try {
          // Double-check the vault currently owns it
          const owner = await pm.ownerOf(tokenId);
          if (String(owner).toLowerCase() !== VAULT.toLowerCase()) continue;

          // 1) Try reading from positions() with multiple ABIs
          let { token0, token1 } = await readTokensFromPositions(manager, tokenId);

          // 2) Fallback: pull from vault FeesClaimed events (works well for V4)
          if (!token0 || !token1) {
            ({ token0, token1 } = await readTokensFromVaultEvents(
              tokenId,
              manager,
              to
            ));
          }

          // 3) Resolve pair label (best-effort)
          const pair = (token0 && token1)
            ? await resolvePairSymbol(token0, token1)
            : "???/???";

          const sender = await inferno.burnedBy(manager, tokenId);

          results.push({
            type: version,
            tokenId,
            manager: manager.toLowerCase(),
            token0: token0 ?? ethers.ZeroAddress,
            token1: token1 ?? ethers.ZeroAddress,
            pair,
            project: "???",
            sender: String(sender).toLowerCase(),
            txHash:
              logs.find(l => BigInt(l.topics[3]).toString() === tokenId)?.transactionHash || "",
            timestamp: (await provider.getBlock(logs[0].blockNumber)).timestamp,
            chain: CHAIN,
          });
        } catch (e) {
          // Skip bad/old tokenIds or transient RPC hiccups
          // console.warn(`skip ${version} ${tokenId}:`, e);
        }
      }
    }
  }

  // ---- Save to vault.json ----
  const filePath = path.join("data", "vault.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
  console.log(`✅ Saved ${results.length} records to ${filePath}`);
}

scanVault().catch(console.error);
