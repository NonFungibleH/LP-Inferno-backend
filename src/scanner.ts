import { ethers } from "ethers";
import fs from "fs";

const VAULT = "0x9be6e6Ea828d5BE4aD1AD4b46d9f704B75052929";
const RPC_URL = process.env.RPC_URL!;
const provider = new ethers.JsonRpcProvider(RPC_URL);

const infernoAbi = JSON.parse(fs.readFileSync("./abis/LpInfernoABI.json", "utf8"));
const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

const MANAGER_NAMES: Record<string, string> = {
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88": "V3",
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc": "V4",
};

const ERC721_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96,address,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
];

async function getTokenSymbol(address: string): Promise<string> {
  const ERC20_ABI = ["function symbol() view returns (string)"];
  try {
    if (!address || address === ethers.ZeroAddress) return "???";
    const token = new ethers.Contract(address, ERC20_ABI, provider);
    const symbol = await token.symbol();
    return symbol;
  } catch (err: any) {
    console.warn(`⚠️ Symbol lookup failed for ${address}: ${err.message}`);
    return address.slice(0, 6); // fallback to shortened address
  }
}

async function resolvePairSymbol(token0: string, token1: string): Promise<string> {
  const [sym0, sym1] = await Promise.all([
    getTokenSymbol(token0),
    getTokenSymbol(token1),
  ]);

  if (sym0 === "???" || sym1 === "???") {
    console.warn(`⚠️ Could not resolve pair symbols for ${token0} / ${token1}`);
  }

  return `${sym0}/${sym1}`;
}

export async function scanVault() {
  const results: any[] = [];
  const fromBlock = 14_200_000;

  // V2
  const depositFilter = inferno.filters.ERC20Deposited();
  const depositLogs = await inferno.queryFilter(depositFilter, fromBlock, "latest");

  for (const log of depositLogs) {
    const { user, token, amount } = inferno.interface.parseLog(log).args;
    const pair = await resolvePairSymbol(token, "0x4200000000000000000000000000000000000006"); // assume WETH pair

    results.push({
      type: "V2",
      token: token.toLowerCase(),
      amount: amount.toString(),
      sender: user.toLowerCase(),
      tx: log.transactionHash,
      block: log.blockNumber,
      pair,
    });
  }

  // V3 & V4
  for (const [manager, version] of Object.entries(MANAGER_NAMES)) {
    const pm = new ethers.Contract(manager, ERC721_ABI, provider);
    const logs = await provider.getLogs({
      address: manager,
      fromBlock,
      toBlock: "latest",
      topics: [ethers.id("Transfer(address,address,uint256)"), null, ethers.zeroPadValue(VAULT, 32)],
    });

    const tokenIds = [...new Set(logs.map(log => BigInt(log.topics[3]).toString()))];

    for (const tokenId of tokenIds) {
      try {
        const owner = await pm.ownerOf(tokenId);
        if (owner.toLowerCase() !== VAULT.toLowerCase()) continue;

        const pos = await pm.positions(tokenId);
        const token0 = pos[2]; // token0 position
        const token1 = pos[3]; // token1 position

        console.log(`🔍 ${version} Token #${tokenId}: token0=${token0}, token1=${token1}`);

        const pair = await resolvePairSymbol(token0, token1);
        const sender = await inferno.burnedBy(manager, tokenId);

        results.push({
          type: version,
          tokenId,
          manager: manager.toLowerCase(),
          token0,
          token1,
          pair,
          project: "???", // placeholder
          sender: sender.toLowerCase(),
        });
      } catch (err: any) {
        console.warn(`❌ Failed to resolve ${version} tokenId ${tokenId}: ${err.message}`);
        // skip failed lookups
      }
    }
  }

  fs.writeFileSync("data/vault.json", JSON.stringify(results, null, 2));
  console.log("✅ Scan complete:", results.length, "records found.");
}
