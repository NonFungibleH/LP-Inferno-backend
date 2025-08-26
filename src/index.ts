import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const VAULT_ADDRESS = "0x37307B774598E5DB1887624Bafbfe4ACdf693b5D";
const V3_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const V4_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";

const START_BLOCK = 33201394;
const INITIAL_CHUNK = 2000;
const FALLBACK_CHUNK = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

const CHAINS = [
  {
    name: "base",
    rpc: process.env.BASE_RPC || "",
    explorer: "https://basescan.org/tx/",
  },
];

const ignoreSymbols = ["USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "BNB", "MATIC"];

// --- chain-specific helpers
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const ETH_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  ethers.ZeroAddress.toLowerCase(),
]);

// Known common token addresses on Base to help with resolution
const KNOWN_BASE_TOKENS: Record<string, string> = {
  "0x4200000000000000000000000000000000000006": "WETH",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0xfde4c96c8593536e31f229ea77223269ed6743e8": "USDT",
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": "DAI",
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": "cbETH",
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": "AERO",
  "0x0000000000000000000000000000000000000000": "ETH",
  "0x1ee40af215451b20449114d26853044ac3f4006f": "DOOM",
};

// ABI for Uniswap V4 Pool to query token0 and token1
const POOL_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// ABI for LPInferno contract (from provided ABI)
const LP_INFERNO_ABI = [
  "function estimateFees(address positionManager, uint256 tokenId) view returns (uint256 amount0, uint256 amount1)",
  "function burnInfo(address,uint256) view returns (address owner, uint64 burnedAt, uint64 lastClaimedAt, bool claimed)",
  "event FeesClaimed(address indexed user, address indexed nft, uint256 indexed tokenId, address token0, address token1, uint256 amount0, uint256 amount1)",
];

// ---------- Robust symbol() with fallbacks + cache ----------
const SYMBOL_ABI_STRING = ["function symbol() view returns (string)"];
const SYMBOL_ABI_BYTES32 = ["function symbol() view returns (bytes32)"];
const NAME_ABI_STRING = ["function name() view returns (string)"];
const NAME_ABI_BYTES32 = ["function name() view returns (bytes32)"];

const symbolCache = new Map<string, string>();

function cleanBytes32ToString(b: string): string {
  try {
    return ethers.decodeBytes32String(b);
  } catch {
    try {
      const raw = ethers.hexlify(b);
      const bytes = ethers.getBytes(raw);
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end--;
      const trimmed = new Uint8Array(bytes.slice(0, end));
      return new TextDecoder().decode(trimmed);
    } catch {
      return "";
    }
  }
}

async function trySymbol(addr: string, provider: ethers.JsonRpcProvider): Promise<string | null> {
  try {
    const result = await new ethers.Contract(addr, SYMBOL_ABI_STRING, provider).symbol();
    if (typeof result === "string" && result.length > 0) return result;
  } catch {}
  try {
    const bytes: string = await new ethers.Contract(addr, SYMBOL_ABI_BYTES32, provider).symbol();
    const s = cleanBytes32ToString(bytes);
    if (s) return s;
  } catch {}
  return null;
}

async function tryName(addr: string, provider: ethers.JsonRpcProvider): Promise<string | null> {
  try {
    const result = await new ethers.Contract(addr, NAME_ABI_STRING, provider).name();
    if (typeof result === "string" && result.length > 0) return result;
  } catch {}
  try {
    const bytes: string = await new ethers.Contract(addr, NAME_ABI_BYTES32, provider).name();
    const n = cleanBytes32ToString(bytes);
    if (n) return n;
  } catch {}
  return null;
}

async function fetchTokenSymbol(address: string, provider: ethers.JsonRpcProvider) {
  const addr = address?.toLowerCase?.() ?? address;
  if (!addr) {
    console.warn(`⚠️ Empty address provided to fetchTokenSymbol`);
    return "???";
  }

  if (ETH_SENTINELS.has(addr)) return "ETH";
  if (addr === BASE_WETH.toLowerCase()) return "WETH";
  if (addr === ethers.ZeroAddress.toLowerCase()) return "ETH";

  if (KNOWN_BASE_TOKENS[addr]) {
    return KNOWN_BASE_TOKENS[addr];
  }

  if (symbolCache.has(addr)) return symbolCache.get(addr)!;

  let sym = await trySymbol(addr, provider);
  if (!sym || sym.length > 32) {
    const name = await tryName(addr, provider);
    if (name && name.length <= 12) sym = name;
  }

  if (!sym || !/^[\x20-\x7E]+$/.test(sym)) {
    console.warn(`⚠️ Could not resolve symbol for token ${addr}`);
    sym = "???";
  }

  symbolCache.set(addr, sym);
  console.log(`✅ Resolved token ${addr} -> ${sym}`);
  return sym;
}

// Retry wrapper for contract calls
async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES, delay = RETRY_DELAY): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      console.log(`Retrying (${i + 1}/${retries})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Retry limit reached");
}

// Enhanced transaction analysis for V4 burns
async function analyzeV4BurnTransaction(
  txHash: string,
  tokenId: string,
  provider: ethers.JsonRpcProvider,
  blockNumber: number
): Promise<{ token0: string; token1: string }> {
  console.log(`🔍 Deep transaction analysis for V4 tokenId ${tokenId} in tx ${txHash}`);

  try {
    const [receipt, tx] = await Promise.all([
      provider.getTransactionReceipt(txHash),
      provider.getTransaction(txHash),
    ]);

    const detectedTokens = new Set<string>();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const decreaseLiquidityTopic = ethers.id("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
    const collectTopic = ethers.id("Collect(uint256,address,uint256,uint256)");
    const poolInitializedTopic = ethers.id("Initialize(address,address,address,uint24,int24)");

    // Strategy 1: Check for native ETH value
    if (tx.value && tx.value > 0n) {
      detectedTokens.add("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      console.log(`  ✅ Native ETH detected: ${ethers.formatEther(tx.value)}`);
    }

    // Strategy 2: Analyze all Transfer events
    const transferLogs = receipt.logs.filter(
      (log) => log.topics[0] === transferTopic && log.topics.length === 3 && log.data !== "0x"
    );

    for (const log of transferLogs) {
      const tokenAddr = log.address.toLowerCase();
      let amount = 0n;
      try {
        amount = ethers.toBigInt(log.data);
      } catch {}

      if (
        amount > 0n &&
        amount < ethers.parseEther("1000000000") &&
        ethers.isAddress(tokenAddr) &&
        tokenAddr !== VAULT_ADDRESS.toLowerCase() &&
        tokenAddr !== V4_MANAGER.toLowerCase()
      ) {
        detectedTokens.add(tokenAddr);
        console.log(`  ✅ Token transfer detected: ${tokenAddr}, amount: ${ethers.formatUnits(amount, 18)}`);
      }
    }

    // Strategy 3: Look for DecreaseLiquidity and Collect events to find pool
    const poolAddresses = new Set<string>();
    const decreaseLogs = receipt.logs.filter((log) => log.topics[0] === decreaseLiquidityTopic);
    const collectLogs = receipt.logs.filter((log) => log.topics[0] === collectTopic);

    for (const log of [...decreaseLogs, ...collectLogs]) {
      const logIndex = receipt.logs.indexOf(log);
      const nextLogs = receipt.logs.slice(logIndex + 1, logIndex + 10);
      for (const nextLog of nextLogs) {
        if (nextLog.topics[0] === transferTopic && nextLog.topics.length === 3) {
          const tokenAddr = nextLog.address.toLowerCase();
          if (
            ethers.isAddress(tokenAddr) &&
            tokenAddr !== VAULT_ADDRESS.toLowerCase() &&
            tokenAddr !== V4_MANAGER.toLowerCase()
          ) {
            detectedTokens.add(tokenAddr);
            console.log(`  ✅ Post-event token: ${tokenAddr}`);
          }
        }
      }
      // Assume the log.address is the pool
      if (ethers.isAddress(log.address) && log.address !== VAULT_ADDRESS && log.address !== V4_MANAGER) {
        poolAddresses.add(log.address.toLowerCase());
        console.log(`  ✅ Potential pool address: ${log.address}`);
      }
    }

    // Strategy 4: Check input data for pool or token addresses
    if (tx.data && tx.data.length > 10) {
      console.log(`  🔍 Analyzing transaction input data...`);
      const selectors = [
        ethers.id("burn(uint256)"), // PositionManager burn
        ethers.id("decreaseLiquidity((uint256,uint128,uint256,uint256))"), // DecreaseLiquidity
        ethers.id("collect((uint256,address,uint128,uint128))"), // Collect
      ];
      for (let i = 10; i < tx.data.length - 40; i += 2) {
        const potential = tx.data.slice(i, i + 42);
        if (potential.length === 42 && potential.startsWith("0x")) {
          try {
            if (ethers.isAddress(potential)) {
              const addr = potential.toLowerCase();
              try {
                const testContract = new ethers.Contract(addr, SYMBOL_ABI_STRING, provider);
                await testContract.symbol({ blockTag: blockNumber });
                if (addr !== VAULT_ADDRESS.toLowerCase() && addr !== V4_MANAGER.toLowerCase()) {
                  detectedTokens.add(addr);
                  console.log(`  ✅ Input data token: ${addr}`);
                }
              } catch {
                // Check if it's a pool
                try {
                  const poolContract = new ethers.Contract(addr, POOL_ABI, provider);
                  await poolContract.token0({ blockTag: blockNumber });
                  poolAddresses.add(addr);
                  console.log(`  ✅ Input data pool: ${addr}`);
                } catch {}
              }
            }
          } catch {}
        }
      }
    }

    // Strategy 5: Query pool addresses for token0 and token1
    for (const poolAddr of poolAddresses) {
      try {
        const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
        const [token0, token1] = await Promise.all([
          poolContract.token0({ blockTag: blockNumber }),
          poolContract.token1({ blockTag: blockNumber }),
        ]);
        if (ethers.isAddress(token0) && ethers.isAddress(token1)) {
          detectedTokens.add(token0.toLowerCase());
          detectedTokens.add(token1.toLowerCase());
          console.log(`  ✅ Pool ${poolAddr} resolved: token0=${token0}, token1=${token1}`);
        }
      } catch (e) {
        console.warn(`  ⚠️ Failed to query pool ${poolAddr}:`, (e as Error).message);
      }
    }

    // Strategy 6: Fallback to FeesClaimed events
    try {
      const feesClaimedTopic = ethers.id(
        "FeesClaimed(address,address,uint256,address,address,uint256,uint256)"
      );
      const logs = await withRetry(() =>
        provider.getLogs({
          address: VAULT_ADDRESS,
          topics: [
            feesClaimedTopic,
            null,
            ethers.zeroPadValue(ethers.getAddress(V4_MANAGER), 32),
            ethers.zeroPadValue(ethers.toBigInt(tokenId), 32),
          ],
          fromBlock: START_BLOCK,
          toBlock: blockNumber,
        })
      );
      if (logs.length > 0) {
        const latestLog = logs[logs.length - 1];
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["address", "address", "uint256", "address", "address", "uint256", "uint256"],
          latestLog.data
        );
        detectedTokens.add(decoded[3].toLowerCase());
        detectedTokens.add(decoded[4].toLowerCase());
        console.log(`  ✅ FeesClaimed resolved: token0=${decoded[3]}, token1=${decoded[4]}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ FeesClaimed resolution failed:`, (e as Error).message);
    }

    const tokenList = Array.from(detectedTokens).sort();

    if (tokenList.length >= 2) {
      console.log(`  ✅ Multi-token resolution: ${tokenList[0]}, ${tokenList[1]}`);
      return { token0: tokenList[0], token1: tokenList[1] };
    } else if (tokenList.length === 1) {
      const token = tokenList[0];
      const eth = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const sorted = token < eth ? { token0: token, token1: eth } : { token0: eth, token1: token };
      console.log(`  ✅ Single token + ETH: ${sorted.token0}, ${sorted.token1}`);
      return sorted;
    }

    if (tx.value && tx.value > 0n) {
      console.log(`  ✅ Fallback to ETH/WETH pair`);
      return {
        token0: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        token1: BASE_WETH.toLowerCase(),
      };
    }

    console.log(`  ⚠️ Could not determine tokens from transaction analysis`);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  } catch (error) {
    console.error(`  ❌ Transaction analysis failed:`, (error as Error).message);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }
}

async function processNFTBurnedLog(log: any, provider: ethers.JsonRpcProvider) {
  const block = await provider.getBlock(log.blockNumber);
  const timestamp = Number(block.timestamp);
  const txHash = log.transactionHash;

  console.log(`🔥 Processing NFTBurned event in tx ${txHash}`);
  const sender = "0x" + log.topics[1].slice(26);
  const manager = "0x" + log.topics[2].slice(26);
  const tokenId = ethers.toBigInt(log.data).toString();

  console.log(`  📍 Processing burn: manager=${manager}, tokenId=${tokenId}`);

  // Validate ownership
  try {
    const erc721Abi = ["function ownerOf(uint256) view returns (address)"];
    const contract = new ethers.Contract(manager, erc721Abi, provider);
    const owner: string = await withRetry(() =>
      contract.ownerOf(tokenId, { blockTag: log.blockNumber })
    );
    console.log(`  ℹ️ tokenId ${tokenId} owned by ${owner}`);
    if (owner.toLowerCase() !== VAULT_ADDRESS.toLowerCase()) {
      console.warn(`  ⚠️ tokenId ${tokenId} not owned by vault ${VAULT_ADDRESS}, owner: ${owner}`);
      return null;
    }
  } catch (e) {
    console.warn(`  ⚠️ ownerOf check failed for tokenId ${tokenId}:`, (e as Error).message);
    return null;
  }

  let token0 = ethers.ZeroAddress;
  let token1 = ethers.ZeroAddress;

  if (manager.toLowerCase() === V4_MANAGER.toLowerCase()) {
    console.log(`  🔄 V4 position detected, using transaction analysis...`);
    const result = await analyzeV4BurnTransaction(txHash, tokenId, provider, log.blockNumber);
    token0 = result.token0;
    token1 = result.token1;
  } else {
    console.log(`  🔄 V3 position detected, using standard resolution...`);
    try {
      const abi = [
        "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
      ];
      const contract = new ethers.Contract(manager, abi, provider);
      const pos = await withRetry(() => contract.positions(tokenId, { blockTag: log.blockNumber }));
      token0 = pos[2].toLowerCase();
      token1 = pos[3].toLowerCase();
      console.log(`  ✅ V3 resolved: token0=${token0}, token1=${token1}`);
    } catch (e) {
      console.warn(`  ⚠️ V3 resolution failed:`, (e as Error).message);
    }
  }

  if (token0 === ethers.ZeroAddress || token1 === ethers.ZeroAddress) {
    console.warn(`  ⚠️ Token resolution failed for tokenId ${tokenId}, skipping...`);
    return null;
  }

  if (token0 === ethers.ZeroAddress) token0 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  if (token1 === ethers.ZeroAddress) token1 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

  const sym0 = await fetchTokenSymbol(token0, provider);
  const sym1 = await fetchTokenSymbol(token1, provider);
  const pair = `${sym0}/${sym1}`;
  const project = ignoreSymbols.includes(sym0) ? sym1 : sym0;
  const type = manager.toLowerCase() === V4_MANAGER.toLowerCase() ? "v4" : "v3";

  console.log(`  ✅ Resolved ${type} position: ${pair} (${project})`);

  return {
    type,
    tokenId,
    manager,
    token0,
    token1,
    pair,
    project,
    sender,
    txHash,
    timestamp,
    vault: VAULT_ADDRESS,
    chain: "base",
  };
}

async function safeGetLogs(
  provider: ethers.JsonRpcProvider,
  params: ethers.Filter,
  fromBlock: number,
  toBlock: number
) {
  let chunkSize = toBlock - fromBlock + 1;
  let retries = 0;
  let currentToBlock = toBlock;

  while (chunkSize > 0 && retries < MAX_RETRIES) {
    try {
      const logs = await provider.getLogs({
        ...params,
        fromBlock,
        toBlock: currentToBlock,
      });
      return logs;
    } catch (err: any) {
      if (err?.message && (err.message.includes("block range") || err.message.includes("ETIMEDOUT")) && chunkSize > 1) {
        chunkSize = Math.floor(chunkSize / 2);
        currentToBlock = fromBlock + chunkSize - 1;
        retries++;
        console.warn(`⚠️ Range too big or timeout, retrying (${retries}/${MAX_RETRIES}) with ${chunkSize} blocks...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      console.error(`❌ Error fetching logs from ${fromBlock} to ${currentToBlock}:`, err);
      throw err;
    }
  }
  console.warn(`⚠️ Exhausted retries for logs from ${fromBlock} to ${toBlock}`);
  return [];
}

async function scanChain(chainName: string, rpcUrl: string) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const endBlock = await provider.getBlockNumber();
  const vaultEntries: any[] = [];

  console.log(`🚀 Starting scan of ${chainName} from block ${START_BLOCK} to ${endBlock}`);

  const ERC20DepositedTopic = ethers.id("ERC20Deposited(address,address,uint256)");
  const NFTBurnedTopic = ethers.id("NFTBurned(address,address,uint256)");

  for (let fromBlock = START_BLOCK; fromBlock <= endBlock; fromBlock += INITIAL_CHUNK) {
    let toBlock = Math.min(endBlock, fromBlock + INITIAL_CHUNK - 1);

    console.log(`🔍 Scanning ${chainName} chunk: ${fromBlock} to ${toBlock}`);

    const logs = await safeGetLogs(provider, { address: VAULT_ADDRESS }, fromBlock, toBlock);

    console.log(`📊 Found ${logs.length} logs in chunk ${fromBlock}-${toBlock}`);

    for (const log of logs) {
      try {
        const block = await provider.getBlock(log.blockNumber);
        const timestamp = Number(block.timestamp);
        const txHash = log.transactionHash;

        if (log.topics[0] === ERC20DepositedTopic) {
          console.log(`💰 Processing ERC20Deposited event in tx ${txHash}`);
          const sender = "0x" + log.topics[1].slice(26);
          const token = "0x" + log.topics[2].slice(26);

          const pairABI = [
            "function token0() view returns (address)",
            "function token1() view returns (address)",
          ];
          const lp = new ethers.Contract(token, pairABI, provider);
          const token0 = await lp.token0();
          const token1 = await lp.token1();

          const sym0 = await fetchTokenSymbol(token0, provider);
          const sym1 = await fetchTokenSymbol(token1, provider);
          const pair = `${sym0}/${sym1}`;
          const project = ignoreSymbols.includes(sym0) ? sym1 : sym0;

          vaultEntries.push({
            type: "v2",
            token,
            token0,
            token1,
            pair,
            project,
            sender,
            txHash,
            timestamp,
            vault: VAULT_ADDRESS,
            chain: chainName,
          });
        } else if (log.topics[0] === NFTBurnedTopic) {
          console.log(`🔥 Processing NFTBurned event in tx ${txHash}`);
          const entry = await processNFTBurnedLog(log, provider);
          if (entry) {
            vaultEntries.push(entry);
          } else {
            console.warn(`  ⚠️ Failed to process NFTBurned event, skipping...`);
          }
        }
      } catch (e) {
        console.error(`❌ Error processing log in tx ${log.transactionHash}:`, (e as Error).message);
        continue;
      }
    }
  }

  console.log(`✅ Completed ${chainName} scan. Found ${vaultEntries.length} total entries`);
  return vaultEntries;
}

async function runMultichainScan() {
  let allVaults: any[] = [];

  for (const chain of CHAINS) {
    if (!chain.rpc) {
      console.warn(`⚠️ No RPC URL provided for ${chain.name}, skipping...`);
      continue;
    }

    try {
      console.log(`🌐 Scanning chain: ${chain.name}`);
      const entries = await scanChain(chain.name, chain.rpc);
      allVaults = allVaults.concat(entries);
      console.log(`✅ Added ${entries.length} entries from ${chain.name}`);
    } catch (e) {
      console.error(`❌ Failed to scan ${chain.name}:`, (e as Error).message);
      continue;
    }
  }

  const outputPath = new URL("../public/data/vault.json", import.meta.url).pathname;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(allVaults, null, 2));
    console.log(`🎉 Successfully saved ${allVaults.length} entries to vault.json`);

    const summary = allVaults.reduce(
      (acc, entry) => {
        acc[entry.type] = (acc[entry.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    console.log(`📊 Summary:`, summary);
  } catch (e) {
    console.error(`❌ Failed to save results:`, (e as Error).message);
    throw e;
  }
}

runMultichainScan().catch((err) => {
  console.error("💥 Scanner failed:", err);
  process.exit(1);
});
