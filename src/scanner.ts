import { ethers } from "ethers";
import fs from "fs";

const VAULT = "0x3d1B6A171CF454DD5f62e49063310e33A8657E0e";

const ABI_BASE_URL = "https://raw.githubusercontent.com/NonFungibleH/LP-Inferno/main";

const MANAGERS = [
  {
    name: "V3",
    address: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    abiUrl: `${ABI_BASE_URL}/components/abis/UniswapV3PositionManager.json`
  },
  {
    name: "V4",
    address: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
    abiUrl: `${ABI_BASE_URL}/components/abis/UniswapV3PositionManager.json`
  },
  {
    name: "V3_CUSTOM",
    address: "0x03a520b32C04BF3bEEf7bEb72e919cF822Ed34f1",
    abiUrl: `${ABI_BASE_URL}/components/abis/UniswapV3PositionManager.json`
  }
];

const fetchAbi = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ABI from ${url}`);
  return res.json();
};

export async function scanVault() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const data: any[] = [];

  const infernoAbi = await fetchAbi(`${ABI_BASE_URL}/app/abis/LpInfernoABI.json`);
  const inferno = new ethers.Contract(VAULT, infernoAbi, provider);

  for (const manager of MANAGERS) {
    const pmAbi = await fetchAbi(manager.abiUrl);
    const pm = new ethers.Contract(manager.address, pmAbi, provider);

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
