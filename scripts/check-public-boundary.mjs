import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicRepos = new Set(['folkways-js', 'folkways-js.git']);
const publicHosts = new Set(['folkways.io', 'www.folkways.io', 'docs.folkways.io']);

// Never print matched content. Fingerprints are compared in memory only.
export function findings(text) {
  const result = [];
  const add = (rule, value) => result.push({
    rule,
    fingerprint: createHash('sha256').update(value).digest('hex'),
  });
  for (const m of text.matchAll(/(?<![@\w])Folkways\/([a-z0-9_.-]+)/gi)) {
    if (!publicRepos.has(m[1].toLowerCase())) add('repository reference', m[0]);
  }
  for (const m of text.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase().replace(/\.$/, '');
    if ((host.endsWith('.folkways.io') && !publicHosts.has(host)) ||
        /(?:^|\.)(?:internal|corp|local|atlassian\.net)$/.test(host)) {
      add('non-public endpoint', m[0]);
    }
  }
  for (const m of text.matchAll(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[ \t]*(?:\r?\n|\\n)(?:[A-Za-z0-9+/=]{20,}[ \t]*(?:\r?\n|\\n))+-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g)) {
    add('embedded key material', m[0]);
  }
  for (const m of text.matchAll(/(?:file:\/\/\/|\/Users\/|\/home\/)[a-z0-9._-]+\/[a-z0-9._/-]+/gi)) {
    add('machine-specific path', m[0]);
  }
  return result;
}

function git(args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
}
function inspect(path, bytes) {
  return [...findings(path), ...(!bytes.includes(0) ? findings(bytes.toString('utf8')) : [])]
    .map((entry) => ({ path, ...entry }));
}
function source(rev) {
  if (!/^[0-9a-f]{40}$/.test(rev) && rev !== 'HEAD') throw new Error('Expected a full commit SHA');
  const paths = git(['ls-tree', '-r', '-z', '--name-only', rev]).toString().split('\0').filter(Boolean);
  return paths.flatMap((path) => inspect(path, git(['show', rev + ':' + path])));
}
function artifact(dir) {
  const walk = (path) => readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return walk(child);
    if (!entry.isFile()) throw new Error('Unexpected package entry type');
    return inspect(relative(dir, child), readFileSync(child));
  });
  return walk(dir);
}

// A finding moved to another file counts as new, as does an additional occurrence.
export function introduced(previous, current) {
  const key = (x) => JSON.stringify([x.path, x.rule, x.fingerprint]);
  const counts = new Map();
  for (const item of previous) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return current.filter((item) => {
    const k = key(item);
    const n = counts.get(k) ?? 0;
    if (n === 0) return true;
    counts.set(k, n - 1);
    return false;
  });
}
function report(label, items) {
  const counts = new Map();
  for (const { rule } of items) counts.set(rule, (counts.get(rule) ?? 0) + 1);
  console.log(label + ': ' + items.length);
  for (const [rule, count] of counts) console.log('  ' + rule + ': ' + count);
}

function main([mode, option, value]) {
  let current, violations;
  if (mode === 'source' && option === '--base' && value) {
    current = source('HEAD');
    violations = introduced(source(value), current);
    report('Existing findings (including any new findings)', current);
  } else if (mode === 'source' && option === '--strict' && !value) {
    current = source('HEAD');
    violations = current;
  } else if (mode === 'artifact' && option && !value) {
    current = artifact(resolve(option));
    violations = current;
  } else {
    throw new Error('Usage: check-public-boundary.mjs source --base SHA | source --strict | artifact DIRECTORY');
  }
  report('Blocking findings', violations);
  if (violations.length) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch { console.error('Public boundary check could not complete.'); process.exitCode = 1; }
}
