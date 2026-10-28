import { defineConfig } from 'tsup';

// The published build has no source maps; `pnpm dev` adds them (--sourcemap).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    server: 'src/server/index.ts',
    'stores/indexeddb': 'src/stores/indexeddb.ts',
    'stores/async-storage': 'src/stores/async-storage.ts',
    'stores/file': 'src/stores/file.ts',
  },
  format: ['cjs', 'esm'],
  target: 'es2020',
  dts: true,
  sourcemap: false,
  clean: true,
  minify: false,
  splitting: false,
});
