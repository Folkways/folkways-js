import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm', 'iife'],
    dts: true,
    splitting: true,
    shims: true,
    sourcemap: true,
    treeshake: true,
    clean: true,
    minify: true,

    globalName: "Realtime",
    banner: {
        js: "window.Folkways = window.Folkways || {};",
    },
    footer: {
        js: "window.Folkways.Realtime = Realtime;",
    },
});
