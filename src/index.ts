import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import LpInfernoABI from "../abis/LpInfernoABI.json" assert { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const INFERNO_CONTRACT = "0x3d1B6A171CF454DD5f62e49063310e33A8657E0e"; // vault
const V3_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";   // Uniswap V3

const inferno = new ethers.Contract(INFERNO_CONTRACT, LpInfernoABI, provider);
const nft = new ethers.Contract(V3_MANAGER, [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
], provider);

async function scanExactVaultHoldings() {
  const balance = await nft.balanceOf(INFERNO_CONTRACT);
  const tokens = [];

  for (let i = 0; i < balance; i++) {
    const tokenId = await nft.tokenOfOwnerByIndex(INFERNO_CONTRACT, i);
    const originalOwner = await inferno.originalOwner(V3_MANAGER, tokenId);
    const burnedAt = await inferno.burnedAt(V3_MANAGER, tokenId);

    tokens.push({
      nft: V3_MANAGER,
      tokenId: tokenId.toString(),
      owner: originalOwner,
      burnedAt: burnedAt.toString()
    });

    console.log(`✅ Token ${tokenId} from ${originalOwner}`);
  }

  const outputPath = path.join(__dirname, "../data/vault.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(tokens, null, 2));
  console.log(`✅ Done: ${tokens.length} tokens written to vault.json`);
}

scanExactVaultHoldings();
