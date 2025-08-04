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
  "function positions(uint256 tokenId) view returns (uint96,address,address token0,address token1,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)"
];

async function resolvePairSymbol(token0: string, token1: string): Promise<string> {
  const ERC20_ABI = ["function symbol() view returns (string)"];
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

export async function scanVault() {
  const results: any[] = [];
  const fromBlock = 14_200_000;

  // V2
  const depositFilter = inferno.filters.ERC20Deposited();
  const depositLogs = await inferno.queryFilter(depositFilter, fromBlock, "latest");
  for (const log of depositLogs) {
    const { user, token, amount } = inferno.interface.parseLog(log).args;
    results.push({
      type: "V2",
      token: token.toLowerCase(),
      amount: amount.toString(),
      sender: user.toLowerCase(),
      tx: log.transactionHash,
      block: log.blockNumber,
      pair: await resolvePairSymbol(token, "0x4200000000000000000000000000000000000006"), // assume WETH pair
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
        const [token0, token1] = [pos.token0, pos.token1];
        const pair = await resolvePairSymbol(token0, token1);
        const sender = await inferno.burnedBy(manager, tokenId);

        results.push({
          type: version,
          tokenId,
          manager: manager.toLowerCase(),
          token0,
          token1,
          pair,
          project: "???", // placeholder until you implement project detection
          sender: sender.toLowerCase(),
        });
      } catch {
        // skip failed lookups
      }
    }
  }

  fs.writeFileSync("data/vault.json", JSON.stringify(results, null, 2));
  console.log("Scan complete:", results.length, "records found.");
}
