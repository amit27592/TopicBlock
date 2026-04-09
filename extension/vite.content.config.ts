/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'path';

// Separate build for the content script.
// Content scripts are injected as classic scripts (no "type: module"),
// so they cannot use ES import statements. We build as IIFE with all
// dependencies inlined — no external chunk imports.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false, // main build already populated dist/
    sourcemap: true,
    rollupOptions: {
      input: {
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
});
