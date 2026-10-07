/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { devLogPlugin } from './vite-plugins/devLog.ts';

function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'nogit';
  }
}

export default defineConfig(({ command }) => {
  const isBuild = command === 'build';
  const buildTime = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const buildId = `${gitShortHash()}${isBuild ? '' : '-dev'}`;
  // GitHub Pages serves the app under /<repo>/.
  const base = isBuild ? (process.env.RALLY_BASE ?? '/neoRacer/') : '/';

  return {
    base,
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    server: { port: 5173, strictPort: true },
    plugins: [
      react(),
      devLogPlugin(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        devOptions: { enabled: false }, // no service worker in dev: avoids stale code
        includeAssets: ['icon.svg'],
        manifest: {
          name: 'Rally Lab',
          short_name: 'Rally Lab',
          description: 'Cutebot measurement lab over Web Bluetooth',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#0d1117',
          theme_color: '#0d1117',
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          navigateFallbackDenylist: [/^\/__/],
        },
      }),
    ],
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
