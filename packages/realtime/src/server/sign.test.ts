import { type KeyObject, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { Code } from '../shared/codes';
import { type SigningAlgorithm, type SigningKey, importSigner, signJwt } from './sign';

const dec = new TextDecoder();

type Curve = { alg: SigningAlgorithm; make: () => { privateKey: KeyObject; publicKey: KeyObject } };
const CURVES: Curve[] = [
  { alg: 'EdDSA', make: () => generateKeyPairSync('ed25519') },
  { alg: 'ES256', make: () => generateKeyPairSync('ec', { namedCurve: 'P-256' }) },
];

const b64url = (s: string) => Buffer.from(s, 'base64url');

/** Signs a token with `key` and checks it against the public key, as the node would. */
async function signsVerifiably(key: SigningKey, publicKey: KeyObject, alg: SigningAlgorithm): Promise<void> {
  const signer = await importSigner(key);
  expect(signer.alg).toBe(alg);
  const token = await signJwt(signer, { sub: 'u' });
  const [h, p, s] = token.split('.');
  expect(JSON.parse(dec.decode(b64url(h!)))).toEqual({ alg, kid: key.kid, typ: 'JWT' });
  // JWS ES256 signatures are r‖s; Node calls that encoding ieee-p1363
  const ok = verify(alg === 'EdDSA' ? null : 'sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b64url(s!));
  expect(ok).toBe(true);
}

const pemBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

async function refused(privateKey: SigningKey['privateKey'], message: string | RegExp, alg?: SigningAlgorithm): Promise<void> {
  await expect(importSigner({ kid: 'k', privateKey, ...(alg ? { alg } : {}) })).rejects.toMatchObject({
    code: Code.InvalidArgument,
    message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message),
  });
}

describe.each(CURVES)('importSigner with $alg keys', ({ alg, make }) => {
  const { privateKey, publicKey } = make();
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  it('reads a PKCS#8 PEM, as the dashboard gives it', async () => {
    await signsVerifiably({ kid: 'k1', privateKey: pkcs8 }, publicKey, alg);
  });

  it('reads a PEM with Windows line endings and surrounding space', async () => {
    await signsVerifiably({ kid: 'k1', privateKey: `\n  ${pkcs8.replace(/\n/g, '\r\n')}  \n` }, publicKey, alg);
  });

  it('reads a one-line PEM with its newlines written as \\n', async () => {
    await signsVerifiably({ kid: 'k1', privateKey: pkcs8.trim().replace(/\n/g, '\\n') }, publicKey, alg);
  });

  it('reads the base64 body alone, without the -----BEGIN lines', async () => {
    await signsVerifiably({ kid: 'k1', privateKey: pemBody(pkcs8) }, publicKey, alg);
  });

  it('reads a JWK, as an object or a JSON string, ignoring alg, use and key_ops', async () => {
    const jwk = { ...(privateKey.export({ format: 'jwk' }) as JsonWebKey), alg: 'whatever', use: 'enc', key_ops: ['verify'] };
    await signsVerifiably({ kid: 'k1', privateKey: jwk }, publicKey, alg);
    await signsVerifiably({ kid: 'k1', privateKey: JSON.stringify(jwk) }, publicKey, alg);
  });

  it('accepts alg when it matches the key', async () => {
    await signsVerifiably({ kid: 'k1', privateKey: pkcs8, alg }, publicKey, alg);
  });

  it('refuses alg when it does not match the key, naming what the key is', async () => {
    const other: SigningAlgorithm = alg === 'EdDSA' ? 'ES256' : 'EdDSA';
    await refused(pkcs8, `signingKey.alg is ${other}, but privateKey is ${alg === 'EdDSA' ? 'an Ed25519' : 'a P-256'} key`, other);
  });

  it('refuses the public half in any form', async () => {
    await refused(publicKey.export({ type: 'spki', format: 'pem' }) as string, 'is a public key');
    await refused(publicKey.export({ format: 'jwk' }) as JsonWebKey, 'is a public JWK');
  });
});

describe('importSigner with P-256 keys in SEC1 form (openssl ecparam -genkey)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const sec1 = privateKey.export({ type: 'sec1', format: 'pem' }) as string;

  it('reads an EC PRIVATE KEY PEM', async () => {
    expect(sec1).toContain('BEGIN EC PRIVATE KEY');
    await signsVerifiably({ kid: 'ec', privateKey: sec1 }, publicKey, 'ES256');
  });

  it('reads its base64 body alone', async () => {
    await signsVerifiably({ kid: 'ec', privateKey: pemBody(sec1) }, publicKey, 'ES256');
  });
});

describe('importSigner refuses what is not an Ed25519 or P-256 private key', () => {
  it('an HS256 shared secret, with a message that says they are gone', async () => {
    await refused('dev-only-secret-change-me', 'shared secrets (HS256) are no longer supported');
    await refused('a'.repeat(64), 'shared secrets (HS256) are no longer supported');
    await refused('', 'not a private key');
    await expect(importSigner({ kid: 'k', privateKey: 'x'.repeat(40), alg: 'HS256' as SigningAlgorithm })).rejects.toMatchObject({
      message: expect.stringContaining('HS256 is no longer supported'),
    });
  });

  it('a key on another curve or of another type', async () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    await refused(p384.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'not a private key we can read');
    await refused(p384.privateKey.export({ format: 'jwk' }) as JsonWebKey, 'EC P-384 key; signing keys are Ed25519 or P-256');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await refused(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, 'not a private key we can read');
    await refused(rsa.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string, 'is a RSA PRIVATE KEY');
  });

  it('OpenSSH and encrypted private keys, saying how to convert them', async () => {
    await refused('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'openssl genpkey -algorithm ed25519');
    const { privateKey } = generateKeyPairSync('ed25519');
    const encrypted = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'pw' }) as string;
    await refused(encrypted, 'is encrypted; decrypt it first');
  });

  it('an OpenSSH public key line', async () => {
    await refused('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA dev@laptop', 'is a public key');
  });

  it('malformed PEMs, JSON and DER', async () => {
    await refused('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', 'not a private key we can read');
    await refused('-----BEGIN PRIVATE KEY-----\nnot base64!\n-----END PRIVATE KEY-----', 'not a private key we can read');
    await refused('-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI', 'not a private key we can read');
    await refused('{"kty":"OKP"', 'not valid JSON');
    // Starts like DER (a SEQUENCE) but isn't a key
    await refused(Buffer.from([0x30, ...new Array<number>(40).fill(0xff)]).toString('base64'), 'not a private key we can read');
  });
});

describe('the mistake that started FLK-211', () => {
  it('a P-256 key pasted without its PEM lines signs ES256, not HS256', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // What was put in RTE_SECRET: the PEM's body, starting MEECAQ… or MIGHAgEA…
    const body = pemBody(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    expect(body).toMatch(/^M/);
    await signsVerifiably({ kid: 'acme-rides-staging-2026-11-2', privateKey: body }, publicKey, 'ES256');
  });
});
