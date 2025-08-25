import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const VAULT_ADDRESS = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const V3_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const V4_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";

// ← vault deployment block
const START_BLOCK = 33201394;

// default chunk size for event scanning
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

// --- CORRECTED V4 ABIs ---
// The issue is that V4 Position Manager doesn't use the same positions() function as V3
// Let's try multiple possible V4 patterns based on common implementations

const V4_POSITION_ABIS = [
  // Pattern 1: Standard ERC721 + metadata
  [
    "function tokenURI(uint256 tokenId) view returns (string)",
    "function ownerOf(uint256 tokenId) view returns (address)"
  ],
  // Pattern 2: Position details via different methods
  [
    "function getPositionInfo(uint256 tokenId) view returns (address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity)",
    "function ownerOf(uint256 tokenId) view returns (address)"
  ],
  // Pattern 3: Direct pool access
  [
    "function poolKeys(uint256 tokenId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
    "function ownerOf(uint256 tokenId) view returns (address)"
  ],
  // Pattern 4: Liquidity position data
  [
    "function liquidityPositions(uint256 tokenId) view returns (address token0, address token1, uint128 liquidity, int24 tickLower, int24 tickUpper)",
    "function ownerOf(uint256 tokenId) view returns (address)"
  ]
];

const V4_POOLMANAGER_ABI = [
  "function getPool(address currency0, address currency1, uint24 fee) view returns (address pool)",
  "function pools(bytes32 poolId) view returns (address currency0, address currency1, uint24 fee, address hooks, int24 tickSpacing)"
];

// Try multiple potential pool manager addresses
const POTENTIAL_V4_POOL_MANAGERS = [
  "0x1631559198a9e474033433b2958dabc135ab6446", // Base fallback
  "0x38EB8B22Df3Ae7fb21e92881151B365Df14ba967", // Alternative
  "0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A", // Another potential
  "0x498581ff718922c3f8e6a244956af099b2652b2b", // From your logs
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

  // Handle native ETH sentinel & Base WETH & Zero Address
  if (ETH_SENTINELS.has(addr)) return "ETH";
  if (addr === BASE_WETH.toLowerCase()) return "WETH";

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

// Enhanced V4 token resolution with multiple strategies
async function resolveV4TokensEnhanced(
  manager: string, 
  tokenId: string, 
  provider: ethers.JsonRpcProvider,
  txHash: string
): Promise<{ token0: string; token1: string }> {
  console.log(`🔄 Enhanced V4 resolution for tokenId ${tokenId}...`);

  // Strategy 1: Try different ABI patterns
  for (let i = 0; i < V4_POSITION_ABIS.length; i++) {
    try {
      console.log(`  📋 Trying ABI pattern ${i + 1}...`);
      const contract = new ethers.Contract(manager, V4_POSITION_ABIS[i], provider);
      
      // Try different function names based on the ABI
      let result: any;
      try {
        if ('getPositionInfo' in contract) {
          result = await contract.getPositionInfo(tokenId);
          if (result && result.length >= 2) {
            return { token0: result[0], token1: result[1] };
          }
        }
        if ('poolKeys' in contract) {
          result = await contract.poolKeys(tokenId);
          if (result && result.length >= 2) {
            return { token0: result[0], token1: result[1] };
          }
        }
        if ('liquidityPositions' in contract) {
          result = await contract.liquidityPositions(tokenId);
          if (result && result.length >= 2) {
            return { token0: result[0], token1: result[1] };
          }
        }
      } catch (e) {
        console.log(`    ❌ Pattern ${i + 1} failed:`, (e as Error).message);
      }
    } catch (e) {
      console.log(`    ❌ ABI pattern ${i + 1} failed:`, (e as Error).message);
    }
  }

  // Strategy 2: Parse transaction receipt for token transfers
  console.log(`  🔄 Trying transaction receipt analysis...`);
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    const tx = await provider.getTransaction(txHash);
    const allTokens = new Set<string>();
    const transferTopic = ethers.id("Transfer(address,address,uint256)");

    // Check for native ETH transfer
    if (tx.value && tx.value > 0n) {
      allTokens.add("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
      console.log(`    ℹ️ Detected native ETH transfer: value=${ethers.formatEther(tx.value)}`);
    }

    // Collect ERC20 transfers
    for (const txLog of receipt.logs) {
      if (txLog.topics[0] === transferTopic && txLog.topics.length === 3) {
        const tokenAddr = txLog.address.toLowerCase();
        const from = "0x" + txLog.topics[1].slice(26).toLowerCase();
        const to = "0x" + txLog.topics[2].slice(26).toLowerCase();

        // Look for transfers involving the vault or user
        if (
          tokenAddr !== VAULT_ADDRESS.toLowerCase() &&
          tokenAddr !== manager.toLowerCase() &&
          ethers.isAddress(tokenAddr) &&
          (from === VAULT_ADDRESS.toLowerCase() || to === VAULT_ADDRESS.toLowerCase())
        ) {
          allTokens.add(tokenAddr);
          console.log(`    ℹ️ Found token transfer: ${tokenAddr}`);
        }
      }
    }

    const tokenList = Array.from(allTokens).sort();
    if (tokenList.length >= 2) {
      console.log(`    ✅ Receipt resolved: ${tokenList[0]}, ${tokenList[1]}`);
      return { token0: tokenList[0], token1: tokenList[1] };
    } else if (tokenList.length === 1) {
      // Assume pair with WETH
      const token0 = tokenList[0];
      const token1 = BASE_WETH.toLowerCase();
      const sorted = token0 < token1 ? { token0, token1 } : { token0: token1, token1: token0 };
      console.log(`    ✅ Receipt resolved single token with WETH: ${sorted.token0}, ${sorted.token1}`);
      return sorted;
    }
  } catch (e) {
    console.log(`    ❌ Receipt analysis failed:`, (e as Error).message);
  }

  // Strategy 3: Try to parse tokenURI if available (some V4 implementations encode metadata)
  console.log(`  🔄 Trying tokenURI metadata parsing...`);
  try {
    const contract = new ethers.Contract(manager, ["function tokenURI(uint256) view returns (string)"], provider);
    const uri = await contract.tokenURI(tokenId);
    
    if (uri && uri.startsWith('data:application/json')) {
      const jsonStr = uri.replace('data:application/json,', '');
      const metadata = JSON.parse(decodeURIComponent(jsonStr));
      
      // Look for token addresses in metadata
      if (metadata.attributes) {
        const token0Attr = metadata.attributes.find((attr: any) => attr.trait_type === 'Token 0' || attr.trait_type === 'token0');
        const token1Attr = metadata.attributes.find((attr: any) => attr.trait_type === 'Token 1' || attr.trait_type === 'token1');
        
        if (token0Attr && token1Attr && ethers.isAddress(token0Attr.value) && ethers.isAddress(token1Attr.value)) {
          console.log(`    ✅ URI metadata resolved: ${token0Attr.value}, ${token1Attr.value}`);
          return { token0: token0Attr.value.toLowerCase(), token1: token1Attr.value.toLowerCase() };
        }
      }
    }
  } catch (e) {
    console.log(`    ❌ URI parsing failed:`, (e as Error).message);
  }

  console.log(`    ⚠️ All V4 resolution strategies failed for tokenId ${tokenId}`);
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

  // Step 1: Resolve tokens based on manager type
  if (manager.toLowerCase() === V4_MANAGER.toLowerCase()) {
    console.log(`  🔄 V4 position detected, using enhanced resolution...`);
    const result = await resolveV4TokensEnhanced(manager, tokenId, provider, txHash);
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
