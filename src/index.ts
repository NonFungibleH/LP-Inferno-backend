import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const VAULT_ADDRESS = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const V3_MANAGER    = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const V4_MANAGER    = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";

// ← vault deployment block
const START_BLOCK   = 33201394;

// default chunk size for event scanning
const INITIAL_CHUNK = 2000;
const FALLBACK_CHUNK = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

const CHAINS = [
  {
    name: "base",
    rpc: process.env.BASE_RPC || "",
    explorer: "https://basescan.org/tx/"
  }
];

const ignoreSymbols = ["USDC","USDT","DAI","WETH","ETH","WBTC","BNB","MATIC"];

// --- chain-specific helpers
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const ETH_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  ethers.ZeroAddress.toLowerCase()
]);

// --- V4 support ---
const V4_PM_ABI_A = [
  "function positions(uint256) view returns (address owner, bytes32 poolId, int24, int24, uint128, uint256, uint256, uint256, uint256)"
];
const V4_PM_ABI_B = [
  "function positions(uint256) view returns (address owner, bytes32 poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint160 feeGrowthInside0LastX128, uint160 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
];

// Additional ABI patterns for V4 positions
const V4_PM_ABI_C = [
  "function positions(uint256) view returns (tuple(address owner, bytes32 poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint160 feeGrowthInside0LastX128, uint160 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1))"
];

const V4_POOLMANAGER_ABI = [
  "function pools(bytes32) view returns (address currency0, address currency1, uint24 fee, address hooks, int24 tickSpacing, uint8 unlocked, uint8 protocolFee, uint8 lpFee)"
];

// Try multiple potential pool manager addresses
const POTENTIAL_V4_POOL_MANAGERS = [
  "0x1631559198a9e474033433b2958dabc135ab6446", // Base fallback
  "0x38EB8B22Df3Ae7fb21e92881151B365Df14ba967", // Alternative
  "0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A",  // Another potential
  "0x498581ff718922c3f8e6a244956af099b2652b2b"  // Added from known deployment
];

// ---------- Robust symbol() with fallbacks + cache ----------
const SYMBOL_ABI_STRING  = ["function symbol() view returns (string)"];
const SYMBOL_ABI_BYTES32 = ["function symbol() view returns (bytes32)"];
const NAME_ABI_STRING    = ["function name() view returns (string)"];
const NAME_ABI_BYTES32   = ["function name() view returns (bytes32)"];

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
    if (typeof result === 'string' && result.length > 0) return result;
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
    if (typeof result === 'string' && result.length > 0) return result;
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

  if (addr === ethers.ZeroAddress) {
    return "ETH"; // Handle native ETH in V4
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

// Try to read PoolManager from PM with multiple methods
async function getPoolManagerAddr(pmAddr: string, provider: ethers.JsonRpcProvider): Promise<string> {
  const tryABIs = [
    ["function manager() view returns (address)", "manager"],
    ["function poolManager() view returns (address)", "poolManager"],
    ["function POOL_MANAGER() view returns (address)", "POOL_MANAGER"]
  ] as const;

  console.log(`🔍 Attempting to resolve PoolManager address from PM: ${pmAddr}`);

  for (const [sig, fn] of tryABIs) {
    try {
      const c = new ethers.Contract(pmAddr, [sig], provider);
      const addr: string = await (c as any)[fn]();
      if (ethers.isAddress(addr) && addr !== ethers.ZeroAddress) {
        console.log(`✅ Found PoolManager via ${fn}(): ${addr}`);
        return addr;
      }
    } catch (e) {
      console.log(`  ❌ ${fn}() failed:`, (e as Error).message);
    }
  }
  
  // Try known addresses
  for (const potentialAddr of POTENTIAL_V4_POOL_MANAGERS) {
    try {
      // Test if this address has the pools() function
      const poolMgr = new ethers.Contract(potentialAddr, V4_POOLMANAGER_ABI, provider);
      const testBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000001";
      await poolMgr.pools(testBytes32); // This will throw if the function doesn't exist
      console.log(`✅ Using fallback PoolManager: ${potentialAddr}`);
      return potentialAddr;
    } catch {}
  }
  
  console.warn(`⚠️ Could not resolve PoolManager address, using fallback`);
  return POTENTIAL_V4_POOL_MANAGERS[0];
}

/** -----------------------------------------------------------------------
 *  NEW: Quick fix — process V4 burns using Transfer events as a fallback
 *  ---------------------------------------------------------------------*/
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

  // Step 1: Try resolving V4 tokens via PoolManager
  if (manager.toLowerCase() === V4_MANAGER.toLowerCase()) {
    console.log(`  🔄 Attempting V4 resolution via PoolManager for tokenId ${tokenId}...`);
    try {
      const positionContract = new ethers.Contract(manager, V4_PM_ABI_B, provider);
      const position = await positionContract.positions(tokenId);
      const poolId = position.poolId;

      // Get the PoolManager address dynamically
      const poolManagerAddr = await getPoolManagerAddr(manager, provider);
      const poolManager = new ethers.Contract(poolManagerAddr, V4_POOLMANAGER_ABI, provider);
      
      const poolInfo = await poolManager.pools(poolId);
      token0 = (poolInfo.currency0 || poolInfo[0]).toLowerCase();
      token1 = (poolInfo.currency1 || poolInfo[1]).toLowerCase();
      
      if (ethers.isAddress(token0) && ethers.isAddress(token1) && 
          token0 !== ethers.ZeroAddress && token1 !== ethers.ZeroAddress) {
        console.log(`  ✅ V4 PoolManager resolved: token0=${token0}, token1=${token1}`);
      } else {
        // Handle native ETH if one is zero
        if (token0 === ethers.ZeroAddress) token0 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        if (token1 === ethers.ZeroAddress) token1 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        console.log(`  ✅ V4 PoolManager resolved with native ETH handling: token0=${token0}, token1=${token1}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ V4 PoolManager resolution failed:`, (e as Error).message);
    }
  }

  // Step 2: Fallback to transaction receipt if PoolManager resolution fails
  if (token0 === ethers.ZeroAddress || token1 === ethers.ZeroAddress) {
    console.log(`  🔄 V4 resolution failed, trying transaction receipt fallback...`);
    
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      const allTokens = new Set<string>();
      
      // Get ALL ERC20 transfers in this transaction
      const transferTopic = ethers.id("Transfer(address,address,uint256)");
      
      // Check for native ETH transfer in the transaction
      const tx = await provider.getTransaction(txHash);
      if (tx.value > 0 && (tx.to?.toLowerCase() === VAULT_ADDRESS.toLowerCase() || tx.to?.toLowerCase() === sender.toLowerCase())) {
        allTokens.add("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"); // Native ETH
      }

      for (const txLog of receipt.logs) {
        if (txLog.topics[0] === transferTopic && txLog.topics.length === 3) {
          const tokenAddr = txLog.address.toLowerCase();
          const from = "0x" + txLog.topics[1].slice(26);
          const to = "0x" + txLog.topics[2].slice(26);
          
          // Look for tokens that moved FROM the vault (fees being collected)
          // or TO the user (position being closed)
          if ((from.toLowerCase() === VAULT_ADDRESS.toLowerCase() || 
               to.toLowerCase() === sender.toLowerCase()) &&
              tokenAddr !== VAULT_ADDRESS.toLowerCase() &&
              tokenAddr !== manager.toLowerCase() &&
              ethers.isAddress(tokenAddr)) {
            allTokens.add(tokenAddr);
          }
        }
      }
      
      const tokenList = Array.from(allTokens).sort();
      if (tokenList.length >= 2) {
        token0 = tokenList[0];
        token1 = tokenList[1];
        console.log(`  ✅ Fallback resolved from transaction: ${token0}, ${token1}`);
      } else if (tokenList.length === 1) {
        // Assume pairing with ETH
        token0 = tokenList[0];
        token1 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        if (token0 > token1) [token0, token1] = [token1, token0]; // Maintain order
        console.log(`  ✅ Fallback resolved single token: ${token0}, ${token1}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Transaction receipt fallback failed:`, (e as Error).message);
    }
  }
  
  if (token0 === ethers.ZeroAddress || token1 === ethers.ZeroAddress) {
    console.warn(`  ⚠️ All resolution methods failed for tokenId ${tokenId}, skipping...`);
    return null;
  }

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
    chain: "base"
  };
}

// Also add this helper function for better V4 token detection
async function detectV4TokensFromPoolManager(poolId: string, provider: ethers.JsonRpcProvider): Promise<{token0: string, token1: string} | null> {
  const poolManagerAddresses = [
    "0x1631559198a9e474033433b2958dabc135ab6446", // Base
    "0x38EB8B22Df3Ae7fb21e92881151B365Df14ba967",
    "0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A"
  ];
  
  for (const poolManagerAddr of poolManagerAddresses) {
    try {
      const poolManager = new ethers.Contract(poolManagerAddr, [
        "function pools(bytes32) view returns (address currency0, address currency1, uint24 fee, address hooks, int24 tickSpacing, uint8 unlocked, uint8 protocolFee, uint8 lpFee)"
      ], provider);
      
      const poolInfo = await poolManager.pools(poolId);
      const token0 = poolInfo.currency0 || poolInfo[0];
      const token1 = poolInfo.currency1 || poolInfo[1];
      
      if (ethers.isAddress(token0) && ethers.isAddress(token1) && 
          token0 !== ethers.ZeroAddress && token1 !== ethers.ZeroAddress) {
        return { token0: token0.toLowerCase(), token1: token1.toLowerCase() };
      }
    } catch (e) {
      continue;
    }
  }
  
  return null;
}

// ---------- Enhanced V4/V3 Position token resolution (existing) ----------
async function fetchPositionTokens(
  manager: string,
  tokenId: string,
  provider: ethers.JsonRpcProvider,
  burnBlock: number,
  txHash: string
) {
  const isV4 = manager.toLowerCase() === V4_MANAGER.toLowerCase();
  
  console.log(`🔍 Resolving tokens for ${isV4 ? 'V4' : 'V3'} position ${tokenId} on manager ${manager}`);

  // Validate tokenId ownership
  try {
    const erc721Abi = ["function ownerOf(uint256) view returns (address)"];
    const contract = new ethers.Contract(manager, erc721Abi, provider);
    const owner: string = await contract.ownerOf(tokenId);
    console.log(`  ℹ️ tokenId ${tokenId} owned by ${owner}`);
    if (owner.toLowerCase() !== VAULT_ADDRESS.toLowerCase()) {
      console.warn(`  ⚠️ tokenId ${tokenId} not owned by vault ${VAULT_ADDRESS}, owner: ${owner}`);
      return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
    }
  } catch (e) {
    console.warn(`  ⚠️ ownerOf check failed for tokenId ${tokenId}:`, (e as Error).message);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }

  // We leave the V4 logic here for completeness, but we won't hit it because V4 burns
  // are now handled earlier by processNFTBurnedLog(). V3 path remains useful.
  if (isV4) {
    console.error(`  ⛔ V4 resolution skipped here (handled in processNFTBurnedLog)`);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }

  // V3 Resolution
  try {
    console.log(`  🔄 Attempting V3 resolution for tokenId ${tokenId}...`);
    const abi = [
      "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
    ];
    const contract = new ethers.Contract(manager, abi, provider);
    const pos = await contract.positions(tokenId);
    console.log(`  ✅ V3 resolved: token0=${pos[2]}, token1=${pos[3]}`);
    return { token0: pos[2], token1: pos[3] };
  } catch (e) {
    console.warn(`  ⚠️ V3 resolution failed:`, (e as Error).message);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }
}

// Small shim so the new quick-fix function compiles without changing your existing resolver's name.
async function fetchPositionTokensFixed(
  manager: string,
  tokenId: string,
  provider: ethers.JsonRpcProvider,
  burnBlock: number,
  txHash: string
) {
  return fetchPositionTokens(manager, tokenId, provider, burnBlock, txHash);
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
        toBlock: currentToBlock
      });
      return logs;
    } catch (err: any) {
      if (err?.message && (err.message.includes("block range") || err.message.includes("ETIMEDOUT")) && chunkSize > 1) {
        chunkSize = Math.floor(chunkSize / 2);
        currentToBlock = fromBlock + chunkSize - 1;
        retries++;
        console.warn(`⚠️ Range too big or timeout, retrying (${retries}/${MAX_RETRIES}) with ${chunkSize} blocks...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
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
  const NFTBurnedTopic      = ethers.id("NFTBurned(address,address,uint256)");

  for (let fromBlock = START_BLOCK; fromBlock <= endBlock; fromBlock += INITIAL_CHUNK) {
    let toBlock = Math.min(endBlock, fromBlock + INITIAL_CHUNK - 1);

    console.log(`🔍 Scanning ${chainName} chunk: ${fromBlock} to ${toBlock}`);

    const logs = await safeGetLogs(
      provider,
      { address: VAULT_ADDRESS },
      fromBlock,
      toBlock
    );

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
            "function token1() view returns (address)"
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
            chain: chainName
          });

        } else if (log.topics[0] === NFTBurnedTopic) {
          console.log(`🔥 Processing NFTBurned event in tx ${txHash}`);
          const sender = "0x" + log.topics[1].slice(26);
          const manager = "0x" + log.topics[2].slice(26);
          const tokenId = ethers.toBigInt(log.data).toString();

          console.log(`  📍 Processing burn: manager=${manager}, tokenId=${tokenId}`);

          // NEW: route V4 burns through the quick-fix processor
          if (manager.toLowerCase() === V4_MANAGER.toLowerCase()) {
            const entry = await processNFTBurnedLog(log, provider);
            if (!entry) {
              console.warn(`  ⚠️ Failed to resolve V4 tokens for tokenId ${tokenId}, skipping...`);
              continue;
            }
            vaultEntries.push(entry);
          } else {
            // V3 legacy path
            const { token0, token1 } = await fetchPositionTokens(manager, tokenId, provider, log.blockNumber, txHash);
            if (token0 === ethers.ZeroAddress || token1 === ethers.ZeroAddress) {
              console.warn(`  ⚠️ Failed to resolve tokens for tokenId ${tokenId}, skipping...`);
              continue;
            }

            const sym0 = await fetchTokenSymbol(token0, provider);
            const sym1 = await fetchTokenSymbol(token1, provider);
            const pair = `${sym0}/${sym1}`;
            const project = ignoreSymbols.includes(sym0) ? sym1 : sym0;
            const type = "v3";

            console.log(`  ✅ Resolved ${type} position: ${pair} (${project})`);

            vaultEntries.push({
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
              chain: chainName
            });
          }
        }
      } catch (e) {
        console.error(`❌ Error processing log in tx ${log.transactionHash}:`, (e as Error).message);
        // Continue processing other logs
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
      // Continue with other chains
    }
  }

  // Create output directory and save results
  const outputPath = new URL("../public/data/vault.json", import.meta.url).pathname;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(allVaults, null, 2));
    console.log(`🎉 Successfully saved ${allVaults.length} entries to vault.json`);
    
    // Log summary
    const summary = allVaults.reduce((acc, entry) => {
      acc[entry.type] = (acc[entry.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
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
