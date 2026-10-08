import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Browser globals that must never appear in the portable core.
const browserGlobals = [
  'window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage',
  'indexedDB', 'fetch', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
  'HTMLElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'ImageData', 'Image',
  'OffscreenCanvas', 'Blob', 'File', 'FileReader', 'URL', 'TextEncoder', 'TextDecoder',
  'Worker', 'self', 'globalThis', 'alert', 'confirm', 'prompt', 'console',
].map((name) => ({ name, message: 'src/core is portable: inject platform APIs through core/types.ts' }));

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'logs', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/**/*.test.ts', 'src/core/testing/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['react', 'react-*', 'react/*'], message: 'No React in src/core.' },
          { group: ['dexie', 'zustand', 'zustand/*'], message: 'Platform libraries belong in adapters or ui.' },
          { group: ['**/adapters/**', '**/ui/**'], message: 'src/core must not depend on adapters or ui.' },
          { group: ['node:*', 'fs', 'path', 'child_process'], message: 'No Node APIs in src/core.' },
        ],
      }],
      'no-restricted-globals': ['error', ...browserGlobals],
    },
  },
  {
    files: ['vite.config.ts', 'vite-plugins/**/*.ts', 'scripts/**/*.mjs', 'src/**/*.test.ts', 'src/core/testing/**', 'engineer/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
