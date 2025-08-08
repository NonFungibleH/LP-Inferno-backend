import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const VAULT_ADDRESS = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const V3_MANAGER    = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const V4_MANAGER    = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";

// ← update this to your new vault’s deployment block
const START_BLOCK   = 33201218;

// default chunk size and max range
const INITIAL_CHUNK = 20000; // Increased for fewer RPC calls
const MAX_BLOCK_RANGE = 50000; // Limit search to last 50,000 blocks for V4 Mint events
const MAX_RETRIES = 3; // Retry attempts for timeout errors
const RETRY_DELAY = 1000; // Delay between retries (ms)

const CHAINS = [
  {
    name: "base",
    rpc: process.env.BASE_RPC || "",
    explorer: "https://basescan.org/tx/"
  }
];

const ignoreSymbols = ["USDC","USDT","DAI","WETH","ETH","WBTC","BNB","MATIC"];

async function fetchTokenSymbol(address: string, provider: ethers.JsonRpcProvider) {
  if (address === ethers.ZeroAddress) return "???";
  const abi = ["function symbol() view returns (string)"];
  try {
    return await new ethers.Contract(address, abi, provider).symbol();
  } catch {
    return "???";
  }
}

async function fetchPositionTokens(
  manager: string,
  tokenId: string,
  provider: ethers.JsonRpcProvider,
  burnBlock: number
) {
  const isV4 = manager.toLowerCase() === V4_MANAGER.toLowerCase();

  if (isV4) {
    // Try fetching token0 and token1 from Mint events
    try {
      const endBlock = await provider.getBlockNumber();
      const searchStartBlock = Math.max(START_BLOCK, endBlock - MAX_BLOCK_RANGE);
      console.log(`🔍 Searching Mint events for tokenId ${tokenId} from block ${searchStartBlock} to ${endBlock}`);
      for (let fromBlock = searchStartBlock; fromBlock <= endBlock; fromBlock += INITIAL_CHUNK) {
        const toBlock = Math.min(fromBlock + INITIAL_CHUNK - 1, endBlock);
        const logs = await safeGetLogs(
          provider,
          {
            address: VAULT_ADDRESS,
            fromBlock,
            toBlock,
            topics: [
              ethers.id("Mint(address,address,uint256,address,address)"), // Hypothetical Mint event
              null, // sender
              ethers.zeroPadValue(manager.toLowerCase(), 32), // manager
              ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32) // Corrected tokenId encoding
            ]
          },
          fromBlock,
          toBlock
        );
        if (logs.length > 0) {
          for (const log of logs) {
            const [, , , token0, token1] = ethers.AbiCoder.defaultAbiCoder().decode(
              ["address", "address", "uint256", "address", "address"],
              log.data
            );
            console.log(`✅ Found Mint event for tokenId ${tokenId} at block ${log.blockNumber}, tx: ${log.transactionHash}`);
            return { token0, token1 };
          }
        }
      }
      console.warn(`⚠️ No Mint event found for tokenId ${tokenId} on V4 manager ${manager} from block ${searchStartBlock} to ${endBlock}`);
    } catch (e) {
      console.warn(`⚠️ V4 token fetch error for tokenId ${tokenId} on manager ${manager}:`, e);
    }
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }

  // V3
  try {
    const abi = [
      "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
    ];
    const pos = await new ethers.Contract(manager, abi, provider).positions(tokenId);
    return { token0: pos[2], token1: pos[3] };
  } catch (e) {
    console.warn(`⚠️ V3 token fetch error for tokenId ${tokenId} on manager ${manager}:`, e);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }
}

async function safeGetLogs(
  provider: ethers.JsonRpcProvider,
  params: ethers.Filter,
  fromBlock: number,
  toBlock: number
) {
  let chunkSize = toBlock - fromBlock;
  let retries = 0;

  while (chunkSize > 0 && retries < MAX_RETRIES) {
    try {
      return await provider.getLogs({
        ...params,
        fromBlock,
        toBlock
      });
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes("block range") || err.message.includes("ETIMEDOUT")) &&
        chunkSize > 1
      ) {
        chunkSize = Math.floor(chunkSize / 2);
        toBlock = fromBlock + chunkSize;
        retries++;
        console.warn(`⚠️ Range too big or timeout, retrying (${retries}/${MAX_RETRIES}) with ${chunkSize} blocks...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        continue;
      }
      console.error(`❌ Error fetching logs from ${fromBlock} to ${toBlock}:`, err);
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

  const ERC20DepositedTopic = ethers.id("ERC20Deposited(address,address,uint256)");
  const NFTBurnedTopic      = ethers.id("NFTBurned(address,address,uint256)");

  for (let fromBlock = START_BLOCK; fromBlock <= endBlock; fromBlock += INITIAL_CHUNK) {
    let toBlock = Math.min(endBlock, fromBlock + INITIAL_CHUNK);

    console.log(`🔍 Scanning ${chainName} from ${fromBlock} to ${toBlock}`);

    const logs = await safeGetLogs(
      provider,
      { address: VAULT_ADDRESS },
      fromBlock,
      toBlock
    );

    for (const log of logs) {
      const block     = await provider.getBlock(log.blockNumber);
      const timestamp = Number(block.timestamp);
      const txHash    = log.transactionHash;

      if (log.topics[0] === ERC20DepositedTopic) {
        const sender = "0x" + log.topics[1].slice(26);
        const token  = "0x" + log.topics[2].slice(26);

        const pairABI = [
          "function token0() view returns (address)",
          "function token1() view returns (address)"
        ];
        const lp     = new ethers.Contract(token, pairABI, provider);
        const token0 = await lp.token0();
        const token1 = await lp.token1();

        const sym0    = await fetchTokenSymbol(token0, provider);
        const sym1    = await fetchTokenSymbol(token1, provider);
        const pair    = `${sym0}/${sym1}`;
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
          chain: chainName
        });

      } else if (log.topics[0] === NFTBurnedTopic) {
        const sender  = "0x" + log.topics[1].slice(26);
        const manager = "0x" + log.topics[2].slice(26);
        const tokenId = ethers.toBigInt(log.data).toString();

        const { token0, token1 } = await fetchPositionTokens(manager, tokenId, provider, log.blockNumber);
        const sym0    = await fetchTokenSymbol(token0, provider);
        const sym1    = await fetchTokenSymbol(token1, provider);
        const pair    = `${sym0}/${sym1}`;
        const project = ignoreSymbols.includes(sym0) ? sym1 : sym0;
        const type    = manager.toLowerCase() === V4_MANAGER.toLowerCase() ? "v4" : "v3";

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
          chain: chainName
        });
      }
    }
  }

  return vaultEntries;
}

async function runMultichainScan() {
  let allVaults: any[] = [];
  for (const chain of CHAINS) {
    const entries = await scanChain(chain.name, chain.rpc);
    allVaults = allVaults.concat(entries);
  }

  const outputPath = new URL("../data/vault.json", import.meta.url).pathname;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(allVaults, null, 2));
  console.log(`✅ Saved ${allVaults.length} entries to vault.json`);
}

runMultichainScan().catch(console.error);
