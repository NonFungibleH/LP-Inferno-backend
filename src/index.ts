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
const FALLBACK_CHUNK = 1000; // Reduced for FeesClaimed fallback
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
  burnBlock: number,
  txHash: string
) {
  const isV4 = manager.toLowerCase() === V4_MANAGER.toLowerCase();

  // Validate tokenId ownership
  let owner: string;
  try {
    const erc721Abi = ["function ownerOf(uint256) view returns (address)"];
    const contract = new ethers.Contract(manager, erc721Abi, provider);
    owner = await contract.ownerOf(tokenId);
    console.log(`ℹ️ tokenId ${tokenId} on manager ${manager} owned by ${owner}`);
    if (owner.toLowerCase() !== VAULT_ADDRESS.toLowerCase()) {
      console.warn(`⚠️ tokenId ${tokenId} not owned by vault ${VAULT_ADDRESS}, owner: ${owner}`);
      return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
    }
  } catch (e) {
    console.warn(`⚠️ ownerOf check failed for tokenId ${tokenId} on manager ${manager}:`, e);
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }

  if (isV4) {
    // Try positions function
    try {
      const abi = [
        "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
      ];
      const contract = new ethers.Contract(manager, abi, provider);
      const pos = await contract.positions(tokenId);
      console.log(`✅ Fetched position data for tokenId ${tokenId} on manager ${manager}`);
      return { token0: pos[2], token1: pos[3] };
    } catch (e) {
      console.warn(`⚠️ positions call failed for tokenId ${tokenId} on manager ${manager}:`, e);
    }

    // Fallback to FeesClaimed event
    try {
      const searchStartBlock = Math.max(START_BLOCK, burnBlock - FALLBACK_CHUNK / 2);
      const searchEndBlock = burnBlock + FALLBACK_CHUNK / 2;
      console.log(`🔍 Fallback: Searching FeesClaimed events for tokenId ${tokenId} from block ${searchStartBlock} to ${searchEndBlock}`);
      const logs = await safeGetLogs(
        provider,
        {
          address: VAULT_ADDRESS,
          fromBlock: searchStartBlock,
          toBlock: searchEndBlock,
          topics: [
            ethers.id("FeesClaimed(address,address,uint256,address,address,uint256,uint256)"),
            null, // user
            ethers.zeroPadValue(manager.toLowerCase(), 32), // nft
            ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32) // tokenId
          ]
        },
        searchStartBlock,
        searchEndBlock
      );
      if (logs.length > 0) {
        for (const log of logs) {
          const [, , , token0, token1] = ethers.AbiCoder.defaultAbiCoder().decode(
            ["address", "address", "uint256", "address", "address", "uint256", "uint256"],
            log.data
          );
          console.log(`✅ Found FeesClaimed event for tokenId ${tokenId} at block ${log.blockNumber}, tx: ${log.transactionHash}`);
          return { token0, token1 };
        }
      }
      console.warn(`⚠️ No FeesClaimed event found for tokenId ${tokenId} on manager ${manager} from block ${searchStartBlock} to ${searchEndBlock}`);
    } catch (e) {
      console.warn(`⚠️ FeesClaimed fetch error for tokenId ${tokenId} on manager ${manager}:`, e);
    }

    // Fallback to tracing NFTBurned transaction
    try {
      console.log(`🔍 Fallback: Tracing NFTBurned transaction ${txHash} for tokenId ${tokenId}`);
      const tx = await provider.getTransaction(txHash);
      if (tx && tx.data) {
        // Decode burnNFT input (nftContract, tokenId)
        const iface = new ethers.Interface(["function burnNFT(address nftContract, uint256 tokenId)"]);
        const decoded = iface.parseTransaction({ data: tx.data });
        if (decoded && decoded.name === "burnNFT" && decoded.args.nftContract.toLowerCase() === manager.toLowerCase()) {
          // Check for related position creation (requires V4 manager ABI)
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt && receipt.logs) {
            for (const log of receipt.logs) {
              // Look for Transfer or mint-related events from V4 manager
              if (log.address.toLowerCase() === manager.toLowerCase()) {
                try {
                  const iface = new ethers.Interface([
                    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
                  ]);
                  const parsed = iface.parseLog(log);
                  if (parsed && parsed.name === "Transfer" && parsed.args.tokenId.toString() === tokenId) {
                    console.log(`ℹ️ Found Transfer event for tokenId ${tokenId} in tx ${txHash}`);
                    // Need position creation event; try fetching from V4 manager logs
                    const mintLogs = await safeGetLogs(
                      provider,
                      {
                        address: manager,
                        fromBlock: burnBlock - FALLBACK_CHUNK / 2,
                        toBlock: burnBlock + FALLBACK_CHUNK / 2,
                        topics: [
                          null, // Assume mint event (unknown signature)
                          null,
                          null,
                          ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32)
                        ]
                      },
                      burnBlock - FALLBACK_CHUNK / 2,
                      burnBlock + FALLBACK_CHUNK / 2
                    );
                    if (mintLogs.length > 0) {
                      console.log(`✅ Found potential mint event for tokenId ${tokenId} at block ${mintLogs[0].blockNumber}, tx: ${mintLogs[0].transactionHash}`);
                      // Requires V4 manager's mint event ABI to decode token0, token1
                      return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress }; // Placeholder; update with actual decoding
                    }
                  }
                } catch (e) {
                  console.warn(`⚠️ Failed to parse log in tx ${txHash}:`, e);
                }
              }
            }
          }
        }
      }
      console.warn(`⚠️ No position data found in NFTBurned tx ${txHash} for tokenId ${tokenId}`);
    } catch (e) {
      console.warn(`⚠️ Transaction tracing error for tokenId ${tokenId} on tx ${txHash}:`, e);
    }
    return { token0: ethers.ZeroAddress, token1: ethers.ZeroAddress };
  }

  // V3
  try {
    const abi = [
      "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
    ];
    const contract = new ethers.Contract(manager, abi, provider);
    const pos = await contract.positions(tokenId);
    console.log(`✅ Fetched position data for tokenId ${tokenId} on manager ${manager}`);
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

        const { token0, token1 } = await fetchPositionTokens(manager, tokenId, provider, log.blockNumber, txHash);
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
