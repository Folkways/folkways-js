import { defineConfig } from 'tsup';

// The published build has no source maps; `pnpm dev` adds them (--sourcemap).
// Watch mode keeps the existing dist/ instead of wiping it, so the example app
// and token server that `pnpm dev` starts alongside always find the SDK.
export default defineConfig((options) => ({
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
  clean: !options.watch,
  minify: false,
  splitting: false,
}));
