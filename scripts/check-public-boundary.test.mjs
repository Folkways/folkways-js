import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findings, introduced } from './check-public-boundary.mjs';

test('accepts public links and local example addresses', () => {
  assert.deepEqual(findings('https://github.com/Folkways/folkways-js https://docs.folkways.io http://localhost:8787'), []);
});
test('rejects links outside the public repository and non-public endpoints', () => {
  const text = ['Folkways', 'unlisted-example'].join('/') + ' https://' + ['service', 'internal'].join('.');
  assert.deepEqual(findings(text).map((x) => x.rule), ['repository reference', 'non-public endpoint']);
});
test('rejects complete embedded key blocks, not placeholders', () => {
  const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const footer = ['-----END', 'PRIVATE KEY-----'].join(' ');
  const key = [header, 'A'.repeat(64), footer].join('\n');
  assert.equal(findings(key)[0].rule, 'embedded key material');
  assert.deepEqual(findings(header + '\n...\n' + footer), []);
});
test('only grandfathered occurrences are allowed in baseline mode', () => {
  const finding = { path: 'a.ts', rule: 'example', fingerprint: 'a' };
  assert.deepEqual(introduced([finding], [finding]), []);
  assert.equal(introduced([finding], [finding, finding]).length, 1);
  assert.equal(introduced([finding], [{ ...finding, path: 'b.ts' }]).length, 1);
  assert.equal(introduced([finding], []).length, 0);
});
