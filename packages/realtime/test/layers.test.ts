import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');

/** Which top-level folders each layer may import from (besides itself). */
const ALLOWED: Record<string, string[]> = {
  api: ['engine', 'shared'],
  engine: ['transport', 'shared'],
  transport: ['shared'],
  shared: [],
  stores: ['engine'],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return p.includes('generated') ? [] : files(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('layering', () => {
  it('api → engine → transport → shared, never upwards or skipping a layer', () => {
    const violations: string[] = [];
    for (const file of files(SRC)) {
      const layer = relative(SRC, file).split('/')[0]!;
      if (!(layer in ALLOWED)) continue; // src/index.ts is the package surface
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
        const target = relative(SRC, resolve(file, '..', m[1]!)).split('/')[0]!;
        if (target !== layer && !ALLOWED[layer]!.includes(target)) {
          violations.push(`${relative(SRC, file)} imports ${m[1]} (${layer} → ${target})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps VERSION equal to package.json', async () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { version: string };
    const { VERSION } = await import('../src/api/version');
    expect(VERSION).toBe(pkg.version);
  });
});
