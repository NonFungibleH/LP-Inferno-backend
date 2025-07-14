import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import LpInfernoABI from "../abis/LpInfernoABI.json" assert { type: "json" };

// === Setup paths ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === RPC provider ===
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// === Contracts ===
const INFERNO_CONTRACT = "0x3d1B6A171CF454DD5f62e49063310e33A8657E0e"; // Your LP Inferno contract
const V3_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";   // Uniswap V3 NFT Manager

const inferno = new ethers.Contract(INFERNO_CONTRACT, LpInfernoABI, provider);

// === Scanner ===
async function scanVaultByOwnership() {
  const tokens = [];
  const MAX_TOKEN_ID = 10000; // You can increase this later

  const iface = new ethers.Interface([
    "function ownerOf(uint256) view returns (address)"
  ]);

  for (let tokenId = 0; tokenId <= MAX_TOKEN_ID; tokenId++) {
    try {
      const data = iface.encodeFunctionData("ownerOf", [tokenId]);
      const result = await provider.call({ to: V3_MANAGER, data });
      const currentOwner = ethers.AbiCoder.defaultAbiCoder().decode(["address"], result)[0];

      if (currentOwner.toLowerCase() === INFERNO_CONTRACT.toLowerCase()) {
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
    } catch (err) {
      // Skip invalid tokens
    }

    if (tokenId % 1000 === 0) {
      console.log(`Scanned up to token ${tokenId}`);
    }
  }

  const outputPath = path.join(__dirname, "../data/vault.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(tokens, null, 2));
  console.log(`✅ Done: ${tokens.length} tokens written to vault.json`);
}

scanVaultByOwnership();
