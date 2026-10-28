// Packs the SDK as it is released: the release workflow attaches this file to the GitHub release and
// publishes it to npm. Writes folkways-realtime-<version>.tgz to the directory given (default: the
// current one) and prints its path.
//
// The package holds only what apps use: the build in dist/ (without source maps), README.md, LICENSE,
// NOTICE, and package.json without the fields only this repository uses (scripts, devDependencies).
// Packing fails if anything else would go in, or if a file that package.json points to is missing.
//
//   pnpm --filter @folkways/realtime build
//   pnpm --filter @folkways/realtime pack:release [directory]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = resolve(process.argv[2] ?? '.');

/** Paths the package may hold, relative to its root. */
const allowed = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^NOTICE$/, /^dist\/.+\.(js|mjs|d\.ts|d\.mts)$/];

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
delete pkg.scripts;
delete pkg.devDependencies;

// Pack a copy, so package.json in the repository is never changed.
const stage = mkdtempSync(join(tmpdir(), 'folkways-pack-'));
try {
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  cpSync(join(pkgDir, '../../README.md'), join(stage, 'README.md'));
  for (const name of ['LICENSE', 'NOTICE', 'dist']) cpSync(join(pkgDir, name), join(stage, name), { recursive: true });

  mkdirSync(outDir, { recursive: true });
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], {
    cwd: stage,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  const [{ filename, files }] = JSON.parse(out);
  const tarball = join(outDir, filename);
  const paths = files.map((f) => f.path);

  const unexpected = paths.filter((p) => !allowed.some((re) => re.test(p)));
  const missing = entryPoints(pkg).filter((p) => !paths.includes(p));
  if (unexpected.length > 0 || missing.length > 0) {
    rmSync(tarball);
    if (unexpected.length > 0) {
      console.error(`Not part of the release: ${unexpected.join(', ')}`);
      console.error('Rebuild with `pnpm build` (`pnpm dev` adds source maps), or add the file to `allowed` here.');
    }
    if (missing.length > 0) console.error(`Missing from the build: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(tarball);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

/** Every file package.json points to: main, module, types and each target in exports. */
function entryPoints({ main, module, types, exports }) {
  const targets = [main, module, types];
  const walk = (value) => {
    if (typeof value === 'string') targets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(exports);
  return [...new Set(targets.filter(Boolean).map((p) => p.replace(/^\.\//, '')))];
}
