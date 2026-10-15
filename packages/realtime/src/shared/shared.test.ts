import { describe, expect, it } from 'vitest';

import { cursor, formatCursor, isAfter, parseCursor } from './cursor';
import { format128, parse128, random128 } from './random';
import { topicError } from './topic';

describe('cursor', () => {
  it('formats and parses u64 pairs exactly', () => {
    const c = cursor('18446744073709551615', 7);
    expect(formatCursor(c)).toBe('18446744073709551615:7');
    expect(parseCursor('18446744073709551615:7')).toEqual(c);
    expect(parseCursor('18446744073709551616:7')).toBeUndefined();
    expect(parseCursor('1:x')).toBeUndefined();
    expect(parseCursor(null)).toBeUndefined();
  });

  it('orders within an epoch; another epoch is always new', () => {
    expect(isAfter(cursor(1, 5), cursor(1, 4))).toBe(true);
    expect(isAfter(cursor(1, 4), cursor(1, 4))).toBe(false);
    expect(isAfter(cursor(1, 3), cursor(1, 4))).toBe(false);
    expect(isAfter(cursor(2, 1), cursor(1, 4))).toBe(true);
    expect(isAfter(cursor(1, 1), undefined)).toBe(true);
  });
});

describe('128-bit ids', () => {
  it('round-trips hex and UUID forms', () => {
    const v = random128();
    expect(parse128(format128(v))).toEqual(v);
    expect(parse128('123e4567-e89b-12d3-a456-426614174000')).toEqual({
      hi: 0x123e4567e89b12d3n,
      lo: 0xa456426614174000n,
    });
    expect(parse128('nope')).toBeUndefined();
  });
});

describe('topic grammar', () => {
  it('accepts the protocol grammar', () => {
    expect(topicError('chat/lobby')).toBeUndefined();
    expect(topicError('a.b_c~d:e@f=g+h-i/J9')).toBeUndefined();
  });

  it('rejects what the node rejects', () => {
    expect(topicError('')).toMatch(/empty/);
    expect(topicError('$sys/x')).toMatch(/reserved/);
    expect(topicError('a//b')).toMatch(/empty level/);
    expect(topicError('chat/lobby ')).toMatch(/characters/);
    expect(topicError('ünï/code')).toMatch(/characters/);
    expect(topicError(Array(17).fill('a').join('/'))).toMatch(/levels/);
    expect(topicError('a'.repeat(256))).toMatch(/255/);
    expect(topicError('chat/*')).toMatch(/characters/);
  });
});
