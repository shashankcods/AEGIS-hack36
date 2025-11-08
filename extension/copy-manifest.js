// copy-manifest.js
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const srcManifest = path.join(root, 'manifest.json');
const dist = path.join(root, 'dist');

function copyFile(srcRelative, destName) {
  const src = path.join(root, srcRelative);
  const dest = path.join(dist, destName);
  if (!fs.existsSync(src)) {
    console.warn('copy-manifest: source missing', src);
    return;
  }
  fs.copyFileSync(src, dest);
  console.log('copied', srcRelative, '->', destName);
}

// create dist if not present
if (!fs.existsSync(dist)) {
  console.error('dist not found. Build failed or run "npm run build" first.');
  process.exit(1);
}

// 1) copy root manifest to dist/manifest.json
if (fs.existsSync(srcManifest)) {
  fs.copyFileSync(srcManifest, path.join(dist, 'manifest.json'));
  console.log('manifest copied to dist/');
} else {
  console.warn('root manifest.json not found.');
}

// 2) copy public assets into dist root
const publicDir = path.join(root, 'public');
if (fs.existsSync(publicDir)) {
  const items = fs.readdirSync(publicDir);
  items.forEach(name => {
    const from = path.join(publicDir, name);
    const to = path.join(dist, name);
    if (fs.lstatSync(from).isDirectory()) {
      // copy directory recursively (icons)
      const destDir = to;
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.readdirSync(from).forEach(file => {
        fs.copyFileSync(path.join(from, file), path.join(destDir, file));
      });
    } else {
      fs.copyFileSync(from, to);
    }
    console.log('copied', name, 'to dist/');
  });
} else {
  console.warn('public directory not found — ensure public/content_script.js and public/background.js exist');
}
