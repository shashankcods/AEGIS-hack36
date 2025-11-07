import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";

// simple, reliable config — uses Node fs to copy public assets after build
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  async closeBundle() {
    try {
      // copy manifest.json into dist/
      if (fs.existsSync("manifest.json")) {
        fs.copyFileSync("manifest.json", "dist/manifest.json");
      }
      // copy public folder (background and content_script and icons)
      if (fs.existsSync("public")) {
        fs.cpSync("public", "dist", { recursive: true });
      }
      console.log("✅ Copied manifest.json and public/ → dist/");
    } catch (err) {
      console.error("❌ Copy failed:", err);
    }
  }
});
