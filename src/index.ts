import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import LpInfernoABI from "../abis/LpInfernoABI.json" assert { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const INFERNO_CONTRACT = "0x3d1B6A171CF454DD5f62e49063310e33A8657E0e"; // your vault

const inferno = new ethers.Contract(INFERNO_CONTRACT, LpInfernoABI, provider);

const NFTBURNED_TOPIC = ethers.id("NFTBurned(address,address,uint256)");
const START_BLOCK = 32724500; // approx 1–2 blocks before the first event in your screenshot

const iface = new ethers.Interface([
  "event NFTBurned(address owner, address collection, uint256 tokenId)",
  "function ownerOf(uint256) view returns (address)"
]);

async function scanBurnedNFTs() {
  const logs = await provider.getLogs({
    address: INFERNO_CONTRACT,
    topics: [NFTBURNED_TOPIC],
    fromBlock: START_BLOCK,
    toBlock: "latest"
  });

  const tokens = [];

  for (const log of logs) {
    const parsed = iface.parseLog(log);
    const collection = parsed.args.collection;
    const tokenId = parsed.args.tokenId.toString();
    const originalOwner = parsed.args.owner;

    try {
      const nft = new ethers.Contract(collection, [
        "function ownerOf(uint256) view returns (address)"
      ], provider);

      const currentOwner = await nft.ownerOf(tokenId);

      if (currentOwner.toLowerCase() === INFERNO_CONTRACT.toLowerCase()) {
        const burnedAt = await inferno.burnedAt(collection, tokenId);
        tokens.push({
          nft: collection,
          tokenId,
          owner: originalOwner,
          burnedAt: burnedAt.toString()
        });

        console.log(`✅ Token ${tokenId} from ${originalOwner} still in vault`);
      }
    } catch (err) {
      // skip if ownerOf fails
    }
  }

  const outputPath = path.join(__dirname, "../data/vault.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(tokens, null, 2));

  console.log(`✅ Scan complete. ${tokens.length} tokens written to vault.json`);
}

scanBurnedNFTs();
