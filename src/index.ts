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

// default chunk size
const INITIAL_CHUNK = 2000;

const CHAINS = [
  {
    name: "base",
    rpc: process.env.BASE_RPC || "",
    explorer: "https://basescan.org/tx/"
  }
];

const ignoreSymbols = ["USDC","USDT","DAI","WETH","ETH","WBTC","BNB","MATIC"];

async function fetchTokenSymbol(address: string, provider: ethers.JsonRpcProvider) {
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
  provider: ethers.JsonRpcProvider
) {
  // Unified ABI for positions (assumes V4 manager supports a similar positions function)
  const positionAbi = [
    "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)"
  ];

  try {
    const contract = new ethers.Contract(manager, positionAbi, provider);
    const pos = await contract.positions(tokenId);
    return { token0: pos[2], token1: pos[3] }; // token0 and token1 are at indices 2 and 3
  } catch (e) {
    console.warn(`⚠️ Failed to fetch position for tokenId ${tokenId} on manager ${manager}:`, e);
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
  while (chunkSize > 0) {
    try {
      return await provider.getLogs({
        ...params,
        fromBlock,
        toBlock
      });
    } catch (err: any) {
      if (
        err.message &&
        err.message.toLowerCase().includes("block range") &&
        chunkSize > 1
      ) {
        chunkSize = Math.floor(chunkSize / 2);
        toBlock = fromBlock + chunkSize;
        console.warn(`⚠️ Range too big, retrying with ${chunkSize} blocks...`);
        continue;
      }
      throw err;
    }
  }
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

        const { token0, token1 } = await fetchPositionTokens(manager, tokenId, provider);
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
