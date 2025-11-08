import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

// We use defineManifest for type-safety and auto-completion
export default defineManifest({
  manifest_version: 3,
  name: pkg.name ?? 'AEGIS',
  version: pkg.version ?? '0.0.0',
  description: pkg.description ?? 'AEGIS extension (CRXJS build)',

  action: {
    default_popup: 'popup.html',
    default_icon: {
      '16': 'icons/icon16.png',
      '32': 'icons/icon32.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png'
    }
  },

  icons: {
    '16': 'icons/icon16.png',
    '32': 'icons/icon32.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png'
  },

  // ✅ UPDATED: Point service_worker to your source file in src/
  background: {
    service_worker: 'src/background/index.js',
    type: 'module'
  },

  content_scripts: [
    {
      matches: ['<all_urls>'],
      // ✅ UPDATED: Point js to your source file in src/
      js: ['src/content/content_script.js'],
      run_at: 'document_idle'
    }
    // ❗ NOTE: Your tree also has 'src/content/main.tsx'.
    // If you want to use THAT file instead, change the js path above to:
    // js: ['src/content/main.tsx'],
  ],

  permissions: [
    'storage',
    'scripting',
    'activeTab',
    'tabs'
  ],

  host_permissions: [
    'http://127.0.0.1/*',
    'https://your-backend.example/*'
  ],

  web_accessible_resources: [
    {
      // This is correct, it allows assets from your 'public/assets' or
      // bundled assets (like images imported in React) to be loaded.
      resources: ['icons/*', 'assets/*'],
      matches: ['<all_urls>']
    }
  ]
});