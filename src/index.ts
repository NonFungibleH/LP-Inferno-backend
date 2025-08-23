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
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
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
  "0x8C4BcBE6b9eF47855f97E675296FA3F6fafa5F1A"  // Another potential
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

  // Handle native ETH sentinel & Base WETH
  if (ETH_SENTINELS.has(addr)) return "ETH";
  if (addr === BASE_WETH.toLowerCase()) return "WETH";

  if (addr === ethers.ZeroAddress) {
    console.warn(`⚠️ Zero address provided to fetchTokenSymbol`);
    return "???";
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

// ---------- Enhanced V4 Position token resolution ----------
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

  if (isV4) {
    console.log(`  🔄 Attempting V4 resolution for tokenId ${tokenId}...`);
    
    // SKIP the positions() call entirely - it's not working
    console.log(`  ⚠️ Skipping positions() call due to interface mismatch, going straight to event-based resolution`);

    // PRIMARY STRATEGY: Analyze the burn transaction itself
    // This is much more efficient and reliable since we already have the txHash

    try {
      console.log(`  🔍 Analyzing burn transaction ${txHash} directly...`);
      const burnReceipt = await provider.getTransactionReceipt(txHash);
      
      if (!burnReceipt) {
        throw new Error("Could not fetch burn transaction receipt");
      }

      console.log(`  📊 Found ${burnReceipt.logs.length} logs in burn transaction`);
      
      // Strategy 1: Look for ERC20 Transfer events in the burn transaction
      const erc20TransferTopic = ethers.id("Transfer(address,address,uint256)");
      const tokenAddresses = new Set<string>();
      
      for (const log of burnReceipt.logs) {
        if (log.topics[0] === erc20TransferTopic && log.topics.length === 3) {
          const tokenAddress = log.address.toLowerCase();
          
          // Skip the NFT transfer itself and vault address
          if (ethers.isAddress(tokenAddress) && 
              tokenAddress !== VAULT_ADDRESS.toLowerCase() && 
              tokenAddress !== manager.toLowerCase()) {
            
            console.log(`  💰 Found ERC20 transfer: ${tokenAddress}`);
            tokenAddresses.add(tokenAddress);
          }
        }
      }
      
      const tokens = Array.from(tokenAddresses);
      
      if (tokens.length >= 2) {
        tokens.sort(); // Ensure consistent ordering
        console.log(`  ✅ Found ${tokens.length} tokens from ERC20 transfers: ${tokens[0]}, ${tokens[1]}`);
        return { token0: tokens[0], token1: tokens[1] };
      }
      
      if (tokens.length === 1) {
        console.log(`  💡 Found single token ${tokens[0]}, assuming paired with WETH`);
        return { token0: tokens[0], token1: BASE_WETH };
      }
      
      // Strategy 2: Look for any logs from the Position Manager contract
      console.log(`  🔍 Looking for Position Manager events...`);
      
      for (const log of burnReceipt.logs) {
        if (log.address.toLowerCase() === manager.toLowerCase()) {
          console.log(`  📋 PM Event - Topics: ${log.topics.length}, Data length: ${log.data.length}`);
          
          // Try to extract token addresses from event data
          if (log.data.length >= 128) {
            try {
              // Many V4 events contain currency addresses in their data
              const dataHex = log.data.slice(2); // Remove 0x prefix
              const chunks = [];
              
              // Split data into 32-byte chunks and look for addresses
              for (let i = 0; i < dataHex.length; i += 64) {
                const chunk = dataHex.slice(i, i + 64);
                if (chunk.length === 64) {
                  const potentialAddress = '0x' + chunk.slice(24); // Last 20 bytes
                  if (ethers.isAddress(potentialAddress) && 
                      potentialAddress !== ethers.ZeroAddress &&
                      potentialAddress.toLowerCase() !== VAULT_ADDRESS.toLowerCase() &&
                      potentialAddress.toLowerCase() !== manager.toLowerCase()) {
                    chunks.push(potentialAddress.toLowerCase());
                  }
                }
              }
              
              // Remove duplicates and take first 2 unique addresses
              const uniqueAddresses = [...new Set(chunks)];
              
              if (uniqueAddresses.length >= 2) {
                console.log(`  💡 Extracted potential tokens from PM event: ${uniqueAddresses[0]}, ${uniqueAddresses[1]}`);
                
                // Validate these are real ERC20 tokens
                try {
                  const [sym0, sym1] = await Promise.all([
                    fetchTokenSymbol(uniqueAddresses[0], provider),
                    fetchTokenSymbol(uniqueAddresses[1], provider)
                  ]);
                  
                  if (sym0 !== "???" && sym1 !== "???") {
                    console.log(`  ✅ Validated tokens: ${sym0}/${sym1}`);
                    return { token0: uniqueAddresses[0], token1: uniqueAddresses[1] };
                  }
                } catch (e) {
                  console.log(`  ❌ Token validation failed:`, (e as Error).message);
                }
              }
            } catch (e) {
              console.log(`  ❌ Failed to parse event data:`, (e as Error).message);
            }
          }
        }
      }
      
      // Strategy 3: Look at the transaction input data
      console.log(`  🔍 Analyzing transaction input data...`);
      const burnTx = await provider.getTransaction(txHash);
      
      if (burnTx?.data && burnTx.data.length > 10) {
        try {
          // The burnNFT call might contain useful information in its calldata
          console.log(`  📝 Transaction data length: ${burnTx.data.length}`);
          
          // Try to decode the burnNFT call
          const vaultInterface = new ethers.Interface([
            "function burnNFT(address nftContract, uint256 tokenId)"
          ]);
          
          try {
            const decoded = vaultInterface.parseTransaction({ data: burnTx.data, value: burnTx.value });
            console.log(`  🔓 Decoded burnNFT call:`, {
              nftContract: decoded.args.nftContract,
              tokenId: decoded.args.tokenId.toString()
            });
          } catch (e) {
            console.log(`  ❌ Could not decode burnNFT call:`, (e as Error).message);
          }
        } catch (e) {
          console.log(`  ❌ Transaction data analysis failed:`, (e as Error).message);
        }
      }
      
      console.warn(`  ⚠️ Burn transaction analysis found no usable token information`);
      
    } catch (e) {
      console.warn(`  ⚠️ Burn transaction analysis failed:`, (e as Error).message);
    }

    
    // FALLBACK: Try a very conservative single-block search around the burn
    try {
      console.log(`  🔄 Trying conservative single-block FeesClaimed search...`);
      
      // Search just the burn block and adjacent blocks
      for (let blockOffset of [0, -1, 1, -2, 2, -5, 5, -10, 10]) {
        const searchBlock = burnBlock + blockOffset;
        if (searchBlock < START_BLOCK) continue;
        
        try {
          console.log(`  🔍 Checking block ${searchBlock} for FeesClaimed events...`);
          
          const logs = await provider.getLogs({
            address: VAULT_ADDRESS,
            fromBlock: searchBlock,
            toBlock: searchBlock,
            topics: [
              ethers.id("FeesClaimed(address,address,uint256,address,address,uint256,uint256)"),
              null,
              ethers.zeroPadValue(manager.toLowerCase(), 32),
              ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32)
            ]
          });
          
          if (logs.length > 0) {
            for (const log of logs) {
              const [, , , token0, token1] = ethers.AbiCoder.defaultAbiCoder().decode(
                ["address", "address", "uint256", "address", "address", "uint256", "uint256"],
                log.data
              );
              console.log(`  ✅ Found FeesClaimed in block ${searchBlock}: token0=${token0}, token1=${token1}`);
              return { token0, token1 };
            }
          }
        } catch (e) {
          // Continue to next block if this one fails
          console.log(`  ❌ Block ${searchBlock} search failed, continuing...`);
        }
      }
      
      console.warn(`  ⚠️ Single-block FeesClaimed search found nothing`);
    } catch (e) {
      console.warn(`  ⚠️ Conservative FeesClaimed search failed:`, (e as Error).message);
    }

    console.error(`  ❌ All V4 resolution methods failed for tokenId ${tokenId}`);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }

  // V3 Resolution (unchanged)
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

          const { token0, token1 } = await fetchPositionTokens(manager, tokenId, provider, log.blockNumber, txHash);
          
          if (token0 === ethers.ZeroAddress || token1 === ethers.ZeroAddress) {
            console.warn(`  ⚠️ Failed to resolve tokens for tokenId ${tokenId}, skipping...`);
            continue;
          }

          const sym0 = await fetchTokenSymbol(token0, provider);
          const sym1 = await fetchTokenSymbol(token1, provider);
          const pair = `${sym0}/${sym1}`;
          const project = ignoreSymbols.includes(sym0) ? sym1 : sym0;
          const type = manager.toLowerCase() === V4_MANAGER.toLowerCase() ? "v4" : "v3";

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
