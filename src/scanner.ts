
import { ethers } from "ethers";
import fs from "fs";
import InfernoABI from "../abis/LpInfernoABI.json" assert { type: "json" };
import PositionManagerABI from "../abis/UniswapV3PositionManager.json" assert { type: "json" };

const VAULT = "0x3d1B6A171CF454DD5f62e49063310e33A8657E0e";

const MANAGERS = [
  {
    name: "V3",
    address: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    abi: PositionManagerABI
  },
  {
    name: "V4",
    address: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    abi: PositionManagerABI
  },
  {
    name: "V3_CUSTOM",
    address: "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1",
    abi: PositionManagerABI
  }
];

export async function scanVault() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const data: any[] = [];

  for (const manager of MANAGERS) {
    const pm = new ethers.Contract(manager.address, manager.abi, provider);
    const inferno = new ethers.Contract(VAULT, InfernoABI, provider);

    for (let id = 1; id <= 2000; id++) {
      try {
        const owner = await pm.ownerOf(id);
        if (owner.toLowerCase() !== VAULT.toLowerCase()) continue;

        const sender = await inferno.originalOwner(manager.address, id);
        data.push({
          tokenId: id.toString(),
          manager: manager.name,
          contract: manager.address,
          sender: sender.toLowerCase()
        });
      } catch {
        continue;
      }
    }
  }

  fs.writeFileSync("data/vault.json", JSON.stringify(data, null, 2));
  console.log("Vault scan complete:", data.length, "tokens found.");
}
