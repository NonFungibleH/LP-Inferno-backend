
import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import { scanVault } from "./scanner.js";

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/vault-tokens", async (req, res) => {
  const wallet = (req.query.wallet || "").toString().toLowerCase();
  if (!wallet) return res.status(400).json({ error: "Missing wallet param" });

  try {
    const data = JSON.parse(fs.readFileSync("data/vault.json", "utf8"));
    const filtered = data.filter((t: any) => t.sender === wallet);
    res.json(filtered);
  } catch {
    res.status(500).json({ error: "No vault data available" });
  }
});

app.post("/scan", async (_, res) => {
  await scanVault();
  res.json({ status: "Scan complete" });
});

app.listen(PORT, () => {
  console.log(`LP Inferno backend running on port ${PORT}`);
});
