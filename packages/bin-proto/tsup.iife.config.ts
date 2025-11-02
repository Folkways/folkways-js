import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['iife'],
  globalName: 'Realtime',               // internal var name for the IIFE
  dts: false,                           // d.ts already emitted by base build
  sourcemap: true,
  clean: false,                         // don't delete dist created by base build
  minify: true,
  splitting: false,
  banner: {
    js: 'window.Folkways = window.Folkways || {};',
  },
  footer: {
    js: 'window.Folkways.Realtime = Realtime;',
  },
  outDir: 'dist',                       // ensure both builds write to same place
});
