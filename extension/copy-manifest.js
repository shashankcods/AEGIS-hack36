// fallback in case vite closeBundle didn't run for your environment
import fs from "fs";
import path from "path";
const src = path.resolve("manifest.json");
const dest = path.resolve("dist/manifest.json");
try {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log("Copied manifest.json to dist/");
  }
  if (fs.existsSync("public")) {
    fs.cpSync("public", "dist", { recursive: true });
    console.log("Copied public/ to dist/");
  }
} catch (e) {
  console.error("Copy error", e);
}
