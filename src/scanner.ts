import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import PositionManagerABI from "../abis/UniswapV3PositionManager.json";
import vault from "../data/vault.json";
import { resolvePair } from "./pairResolver";

dotenv.config();

const BASE_RPC = process.env.BASE_RPC!;
const provider = new ethers.JsonRpcProvider(BASE_RPC);

// V4 Position Manager
const V4_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
const manager = new ethers.Contract(V4_MANAGER, PositionManagerABI, provider);

async function scanVault() {
  const updated = await Promise.all(
    vault.map(async (entry: any) => {
      const { type, tokenId, token0, token1 } = entry;

      // Only update missing V4 tokens
      if (
        type === "v4" &&
        token0 === ethers.ZeroAddress &&
        token1 === ethers.ZeroAddress
      ) {
        try {
          const pos = await manager.positions(BigInt(tokenId));
          const token0Addr = pos.token0 || pos[2];
          const token1Addr = pos.token1 || pos[3];

          console.log(`✅ Fetched V4 token metadata for ${tokenId}:`, token0Addr, token1Addr);

          entry.token0 = token0Addr;
          entry.token1 = token1Addr;
          entry.pair = await resolvePair(token0Addr, token1Addr, provider);
        } catch (e) {
          console.warn(`❌ Failed to fetch V4 position ${tokenId}:`, e);
        }
      }

      return entry;
    })
  );

  const filepath = path.resolve(__dirname, "../data/vault.json");
  fs.writeFileSync(filepath, JSON.stringify(updated, null, 2));
  console.log("✅ Vault metadata updated.");
}

scanVault().catch((err) => console.error("❌ Scanner error:", err));
