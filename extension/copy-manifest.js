// copy-manifest.js — safe full copier for Chrome Extension build
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const buildTemp = path.join(root, 'build_temp');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copy(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true, force: true });
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function safeCopy(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-manifest] skip: ${src} not found`);
    return;
  }
  try {
    copy(src, dest);
    console.log(`[copy-manifest] copied: ${src} → ${dest}`);
  } catch (e) {
    console.error(`[copy-manifest] failed to copy ${src}:`, e.message);
  }
}

(function main() {
  ensureDir(distDir);

  // 1️⃣ Copy essentials from public/
  safeCopy(path.join(root, 'manifest.json'), path.join(distDir, 'manifest.json'));
  safeCopy(path.join(publicDir, 'background.js'), path.join(distDir, 'background.js'));
  safeCopy(path.join(publicDir, 'content_script.js'), path.join(distDir, 'content_script.js'));
  safeCopy(path.join(publicDir, 'icons'), path.join(distDir, 'icons'));

  // 2️⃣ Copy popup build from build_temp/
  const popupHtml = path.join(buildTemp, 'index.html');
  const popupAssets = path.join(buildTemp, 'assets');
  if (fs.existsSync(popupHtml)) {
    safeCopy(popupHtml, path.join(distDir, 'index.html'));
  } else {
    console.warn('[copy-manifest] popup HTML missing; run vite build first');
  }
  if (fs.existsSync(popupAssets)) {
    safeCopy(popupAssets, path.join(distDir, 'assets'));
  }

  console.log('\n✅ [copy-manifest] Build copy complete. Ready to load dist/ in Chrome.');
})();
