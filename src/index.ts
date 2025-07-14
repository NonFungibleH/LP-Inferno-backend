import fs from "fs";
import path from "path";

const outputPath = path.join(__dirname, "../data/vault.json");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

fs.writeFileSync(outputPath, JSON.stringify({ status: "test success" }, null, 2));

console.log("✅ Wrote vault.json");
