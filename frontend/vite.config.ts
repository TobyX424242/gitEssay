/**
 * gitEssay frontend — Vite config.
 *
 * Forked from lexical-playground's vite.config.ts but stripped of the monorepo
 * helpers (lexicalMonorepoPlugin, viteCopyEsm, viteCopyExcalidrawAssets, the
 * error-code transform) since we consume @lexical/* from npm, not the workspace.
 *
 * What remains and why:
 *  - @vitejs/plugin-react  — JSX/fast-refresh.
 *  - @rollup/plugin-babel  — strips Flow type annotations from the playground's
 *                            `.js`/`.jsx` sources (they ship with Flow types) and
 *                            applies the automatic JSX runtime. Matches upstream.
 */
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import babel from '@rollup/plugin-babel';

export default defineConfig(() => ({
  // Production minify uses Vite's default (rolldown/oxc in Vite 8); lexical
  // identifies nodes by getType() strings, not class names, so no keepNames.
  build: {
    outDir: 'build',
    target: 'es2022',
  },
  server: {
    // Avoid the host's squatted 5173/8000 ports; gitEssay uses 5180.
    port: 5180,
    host: true,
    // Proxy API calls to the FastAPI backend (avoids CORS in dev).
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    babel({
      babelHelpers: 'bundled',
      babelrc: false,
      configFile: false,
      extensions: ['jsx', 'js', 'ts', 'tsx', 'mjs'],
      exclude: '**/node_modules/**',
      plugins: ['@babel/plugin-transform-flow-strip-types'],
      presets: [['@babel/preset-react', {runtime: 'automatic'}]],
    }),
  ],
}));
