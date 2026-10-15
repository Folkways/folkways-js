import { describe, expect, it } from 'vitest';

import { Code as WireCode } from '../transport/wire/generated/rte/v1/code.js';
import { Code, WIRE_CODES, codeInfo, isFatalCloseCode } from './codes';

describe('codes', () => {
  const schemaCodes = Object.values(WireCode).filter((v): v is number => typeof v === 'number');

  it('mirrors every code in the schema, with the same name and value', () => {
    expect([...WIRE_CODES].sort((a, b) => a - b)).toEqual([...schemaCodes].sort((a, b) => a - b));
    for (const v of schemaCodes) {
      const name = WireCode[v]!;
      expect(Code[name as keyof typeof Code]).toBe(v);
      expect(codeInfo(v).name).toBe(name);
    }
  });

  it('maps families like rte/src/proto/codes.rs', () => {
    for (const v of schemaCodes) {
      const status = codeInfo(v).httpStatus;
      switch (Math.floor(v / 100)) {
        case 0:
          expect(status).toBe(200);
          break;
        case 1:
        case 4:
          expect(status).toBeGreaterThanOrEqual(400);
          expect(status).toBeLessThan(500);
          break;
        case 2:
          expect([401, 403, 409]).toContain(status);
          break;
        case 3:
          expect(status).toBeGreaterThanOrEqual(400);
          break;
        case 5:
          expect(status).toBeGreaterThanOrEqual(500);
          break;
        default:
          throw new Error(`code outside families: ${v}`);
      }
    }
  });

  it('keeps the retry contract of the protocol guide', () => {
    expect(codeInfo(Code.AuthInvalid)).toMatchObject({ retry: 'never', closesConnection: true });
    expect(codeInfo(Code.AuthExpired).retry).toBe('after-reauth');
    expect(codeInfo(Code.Draining)).toMatchObject({ retry: 'reconnect', closesConnection: true });
    expect(codeInfo(Code.Backpressure)).toMatchObject({ retry: 'backoff', closesConnection: true });
    expect(codeInfo(Code.RateLimited)).toMatchObject({ retry: 'backoff', closesConnection: false });
    expect(isFatalCloseCode(Code.AuthInvalid)).toBe(true);
    expect(isFatalCloseCode(Code.Backpressure)).toBe(false);
    expect(isFatalCloseCode(Code.Draining)).toBe(false);
  });

  it('describes unknown codes without throwing', () => {
    expect(codeInfo(9999)).toMatchObject({ name: 'Code9999', retry: 'never' });
  });
});
