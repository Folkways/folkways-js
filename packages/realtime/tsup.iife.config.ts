import { defineConfig } from 'tsup';

// Browser <script> build: exposes the package exports as `window.Folkways`,
// so `Folkways.connect(...)` works without a bundler.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['iife'],
  target: 'es2020',
  globalName: 'Folkways',
  dts: false,
  sourcemap: true,
  clean: false,
  minify: true,
  splitting: false,
  outDir: 'dist',
});
