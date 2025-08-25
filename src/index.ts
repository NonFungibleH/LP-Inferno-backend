import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const VAULT_ADDRESS = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
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
  "0x0000000000000000000000000000000000000000": "ETH"
};

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

  // Handle native ETH sentinel & Base WETH & Zero Address
  if (ETH_SENTINELS.has(addr)) return "ETH";
  if (addr === BASE_WETH.toLowerCase()) return "WETH";
  if (addr === ethers.ZeroAddress.toLowerCase()) return "ETH";

  // Check known tokens first
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

// Enhanced transaction analysis specifically for V4 burns
async function analyzeV4BurnTransaction(
  txHash: string,
  tokenId: string,
  provider: ethers.JsonRpcProvider
): Promise<{ token0: string; token1: string }> {
  console.log(`🔍 Deep transaction analysis for V4 tokenId ${tokenId} in tx ${txHash}`);

  try {
    const [receipt, tx] = await Promise.all([
      provider.getTransactionReceipt(txHash),
      provider.getTransaction(txHash)
    ]);

    const detectedTokens = new Set<string>();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    const decreaseLiquidityTopic = ethers.id("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
    const collectTopic = ethers.id("Collect(uint256,address,uint256,uint256)");

    // Strategy 1: Check for native ETH value
    if (tx.value && tx.value > 0n) {
      detectedTokens.add(ethers.ZeroAddress);
      console.log(`  ✅ Native ETH detected: ${ethers.formatEther(tx.value)}`);
    }

    // Strategy 2: Analyze all Transfer events involving meaningful amounts
    const transferLogs = receipt.logs.filter(log => 
      log.topics[0] === transferTopic && 
      log.topics.length === 3 &&
      log.data !== "0x" // Has amount data
    );

    for (const log of transferLogs) {
      const tokenAddr = log.address.toLowerCase();
      const from = "0x" + log.topics[1].slice(26).toLowerCase();
      const to = "0x" + log.topics[2].slice(26).toLowerCase();
      
      // Parse amount to filter out dust/spam tokens
      let amount = 0n;
      try {
        amount = ethers.toBigInt(log.data);
      } catch {}

      // Include tokens with meaningful transfers (> 0 and reasonable size)
      if (
        amount > 0n &&
        amount < ethers.parseEther("1000000000") && // Reasonable upper bound
        tokenAddr !== VAULT_ADDRESS.toLowerCase() &&
        tokenAddr !== V4_MANAGER.toLowerCase() &&
        ethers.isAddress(tokenAddr) &&
        // Must involve the vault or user in some way
        (from === VAULT_ADDRESS.toLowerCase() || 
         to === VAULT_ADDRESS.toLowerCase() ||
         // Or be part of the position closure/burn process
         from === V4_MANAGER.toLowerCase() ||
         to === V4_MANAGER.toLowerCase())
      ) {
        detectedTokens.add(tokenAddr);
        console.log(`  ✅ Token transfer detected: ${tokenAddr} amount: ${amount.toString()}`);
      }
    }

    // Strategy 3: Look for DecreaseLiquidity events (position closure)
    const decreaseLogs = receipt.logs.filter(log => log.topics[0] === decreaseLiquidityTopic);
    if (decreaseLogs.length > 0) {
      console.log(`  ✅ Found DecreaseLiquidity events: ${decreaseLogs.length}`);
      
      // Try to find associated token transfers right after decrease
      for (const decreaseLog of decreaseLogs) {
        const logIndex = receipt.logs.indexOf(decreaseLog);
        const nextLogs = receipt.logs.slice(logIndex + 1, logIndex + 10); // Check next few logs
        
        for (const nextLog of nextLogs) {
          if (nextLog.topics[0] === transferTopic && nextLog.topics.length === 3) {
            const tokenAddr = nextLog.address.toLowerCase();
            if (ethers.isAddress(tokenAddr) && 
                tokenAddr !== VAULT_ADDRESS.toLowerCase() &&
                tokenAddr !== V4_MANAGER.toLowerCase()) {
              detectedTokens.add(tokenAddr);
              console.log(`  ✅ Post-decrease token: ${tokenAddr}`);
            }
          }
        }
      }
    }

    // Strategy 4: Check input data for encoded token addresses
    if (tx.data && tx.data.length > 10) {
      const inputData = tx.data;
      console.log(`  🔍 Analyzing transaction input data...`);
      
      // Look for 20-byte patterns that might be addresses
      for (let i = 0; i < inputData.length - 40; i += 2) {
        const potential = inputData.slice(i, i + 42);
        if (potential.length === 42 && potential.startsWith('0x')) {
          try {
            if (ethers.isAddress(potential)) {
              const addr = potential.toLowerCase();
              // Check if this looks like a token (has symbol/name functions)
              try {
                const testContract = new ethers.Contract(addr, SYMBOL_ABI_STRING, provider);
                await testContract.symbol();
                if (addr !== VAULT_ADDRESS.toLowerCase() && 
                    addr !== V4_MANAGER.toLowerCase()) {
                  detectedTokens.add(addr);
                  console.log(`  ✅ Input data token: ${addr}`);
                }
              } catch {
                // Not a token, continue
              }
            }
          } catch {}
        }
      }
    }

    // Convert to sorted array
    const tokenList = Array.from(detectedTokens).sort();
    
    // Return the best pair we can find
    if (tokenList.length >= 2) {
      console.log(`  ✅ Multi-token resolution: ${tokenList[0]}, ${tokenList[1]}`);
      return { token0: tokenList[0], token1: tokenList[1] };
    } else if (tokenList.length === 1) {
      // Pair with WETH as fallback
      const token = tokenList[0];
      const weth = BASE_WETH.toLowerCase();
      const sorted = token < weth ? { token0: token, token1: weth } : { token0: weth, token1: token };
      console.log(`  ✅ Single token + WETH: ${sorted.token0}, ${sorted.token1}`);
      return sorted;
    }

    // Final fallback - if we found ETH transfers, assume ETH/WETH pair
    if (tx.value && tx.value > 0n) {
      console.log(`  ✅ Fallback to ETH/WETH pair`);
      return { 
        token0: ethers.ZeroAddress, 
        token1: BASE_WETH.toLowerCase()
      };
    }

  } catch (error) {
    console.error(`  ❌ Transaction analysis failed:`, (error as Error).message);
  }

  console.log(`  ⚠️ Could not determine tokens from transaction analysis`);
  return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
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

  let token0 = ethers.ZeroAddress;
  let token1 = ethers.ZeroAddress;

  if (manager.toLowerCase() === V4_MANAGER.toLowerCase()) {
    console.log(`  🔄 V4 position detected, using transaction analysis...`);
    const result = await analyzeV4BurnTransaction(txHash, tokenId, provider);
    token0 = result.token0;
    token1 = result.token1;
  } else {
    // V3 Resolution (existing logic)
    console.log(`  🔄 V3 position detected, using standard resolution...`);
    try {
      const abi = [
        "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
      ];
      const contract = new ethers.Contract(manager, abi, provider);
      const pos = await contract.positions(tokenId);
      token0 = pos[2].toLowerCase();
      token1 = pos[3].toLowerCase();
      console.log(`  ✅ V3 resolved: token0=${token0}, token1=${token1}`);
    } catch (e) {
      console.warn(`  ⚠️ V3 resolution failed:`, (e as Error).message);
    }
  }

  // Validate tokens
  if (token0 === ethers.ZeroAddress || token1 === ethers.ZeroAddress) {
    console.warn(`  ⚠️ Token resolution failed for tokenId ${tokenId}, skipping...`);
    return null;
  }

  // Handle native ETH representation
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
