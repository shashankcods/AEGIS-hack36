// manifest.config.ts
import pkg from './package.json';

const manifest: any = {
  manifest_version: 3,
  name: (pkg as any).name ?? 'AEGIS',
  version: (pkg as any).version ?? '0.0.0',
  description: (pkg as any).description ?? 'AEGIS extension (CRXJS build)',

  // Tell CRXJS where the popup source lives so it can be bundled.
  action: {
    default_popup: 'src/popup/index.html',
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

  background: {
    // point at your source service worker (js or ts)
    service_worker: 'src/background/index.js',
    type: 'module'
  },

  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content_script.ts'],
      run_at: 'document_idle'
    }
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
      resources: ['icons/*', 'assets/*'],
      matches: ['<all_urls>']
    }
  ]
};

export default manifest;
