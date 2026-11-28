import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The TypeScript blocks in the root README form a single quick-start example.
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = join(root, 'packages/realtime');
const markdown = readFileSync(join(root, 'README.md'), 'utf8');
const blocks = [...markdown.matchAll(/^```(?:ts|typescript)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
if (!blocks.length) throw new Error('No README TypeScript examples found');
const temp = mkdtempSync(join(pkg, '.readme-check-'));
try {
  const path = join(temp, 'example.mts');
  writeFileSync(path, blocks.map((block) => block[1]).join('\n\n'));
  execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '--strict', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--lib', 'ES2022,DOM', path], { cwd: pkg, stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
