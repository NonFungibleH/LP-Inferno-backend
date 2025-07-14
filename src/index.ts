import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import LpInfernoABI from "../abis/LpInfernoABI.json" assert { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

// === CONFIG ===
const INFERNO_CONTRACT = "0x3d1B6A171CF454DD5f62e49063310e33A8657E0e"; // your real contract
const V3_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // Uniswap V3 NFT
const START_TOKEN_ID = 0;
const END_TOKEN_ID = 500000; // can lower this for faster scans

// === LOAD CONTRACT ===
const inferno = new ethers.Contract(INFERNO_CONTRACT, LpInfernoABI, provider);

const vaultEntries = [];

async function scanVault() {
  for (let tokenId = START_TOKEN_ID; tokenId <= END_TOKEN_ID; tokenId++) {
    try {
      const owner = await inferno.originalOwner(V3_MANAGER, tokenId);
      const currentOwner = await provider.call({
        to: V3_MANAGER,
        data: new ethers.Interface(["function ownerOf(uint256) view returns (address)"])
          .encodeFunctionData("ownerOf", [tokenId])
      });

      const decodedOwner = ethers.AbiCoder.defaultAbiCoder().decode(["address"], currentOwner)[0];
      const burnedAt = await inferno.burnedAt(V3_MANAGER, tokenId);

      if (decodedOwner.toLowerCase() === INFERNO_CONTRACT.toLowerCase()) {
        vaultEntries.push({
          nft: V3_MANAGER,
          tokenId: tokenId.toString(),
          owner,
          burnedAt: burnedAt.toString()
        });
        console.log(`✅ Found token ${tokenId} sent to vault by ${owner}`);
      }
    } catch (err) {
      // Likely means tokenId doesn't exist yet — skip silently
    }

    if (tokenId % 1000 === 0) {
      console.log(`Scanned up to tokenId ${tokenId}`);
    }
  }

  // Write to vault.json
  const outputPath = path.join(__dirname, "../data/vault.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(vaultEntries, null, 2));
  console.log(`✅ Scan complete. Found ${vaultEntries.length} vault tokens.`);
}

scanVault();
