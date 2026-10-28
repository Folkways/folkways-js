// Copies the version in package.json into src/api/version.ts. `pnpm version-packages` runs it after
// `changeset version`, which only bumps package.json; a test checks the two match.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../src/api/version.ts', import.meta.url);
const source = readFileSync(file, 'utf8');
const pattern = /export const VERSION = '[^']*';/;
if (!pattern.test(source)) throw new Error(`no \`export const VERSION = '…';\` in ${file.pathname}`);
writeFileSync(file, source.replace(pattern, `export const VERSION = '${version}';`));
