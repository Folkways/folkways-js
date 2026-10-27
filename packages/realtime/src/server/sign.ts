import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';

export type SigningAlgorithm = 'EdDSA' | 'ES256' | 'HS256';

/** One of the segment's signing keys, with its private half. Keep it on your server. */
export interface SigningKey {
  /** The key's id in the segment (its `kid`), as the dashboard shows it. */
  kid: string;
  /** The private key as a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`) for EdDSA or ES256, or the shared secret for HS256. */
  privateKey: string;
  /** Read from `privateKey` when left out: a PEM is Ed25519 or P-256, anything else an HS256 secret. */
  alg?: SigningAlgorithm;
}

/** Signs JWT signing inputs with an imported key. */
export interface Signer {
  readonly alg: SigningAlgorithm;
  readonly kid: string;
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
}

const enc = new TextEncoder();

const invalid = (message: string, cause?: unknown) => new RealtimeError(Code.InvalidArgument, { message, local: true, cause });

export function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemBody(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const IMPORT: Record<'EdDSA' | 'ES256', AlgorithmIdentifier | EcKeyImportParams> = {
  EdDSA: { name: 'Ed25519' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
};

const SIGN: Record<SigningAlgorithm, AlgorithmIdentifier | EcdsaParams> = {
  EdDSA: { name: 'Ed25519' },
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
  HS256: { name: 'HMAC' },
};

/**
 * Imports a signing key with WebCrypto, so it works on Node 20+, Deno, Bun
 * and edge runtimes without a JWT library. ES256 signatures come out as
 * r‖s, which is what JWS expects.
 */
export async function importSigner(key: SigningKey): Promise<Signer> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new RealtimeError(Code.TransportUnavailable, { message: 'WebCrypto (crypto.subtle) is unavailable in this runtime', local: true });
  const material = key.privateKey.trim();
  const make = (alg: SigningAlgorithm, cryptoKey: CryptoKey): Signer => ({
    alg,
    kid: key.kid,
    sign: async (data) => new Uint8Array(await subtle.sign(SIGN[alg], cryptoKey, data)),
  });

  if (!material.startsWith('-----BEGIN')) {
    if (key.alg && key.alg !== 'HS256') throw invalid(`signingKey.alg is ${key.alg}, but privateKey is not a PEM`);
    const cryptoKey = await subtle.importKey('raw', enc.encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return make('HS256', cryptoKey);
  }
  if (material.includes('PUBLIC KEY')) {
    throw invalid('signingKey.privateKey is a public key; give the private key (the one the dashboard showed once, or your .pem)');
  }
  if (material.includes('BEGIN EC PRIVATE KEY')) {
    throw invalid('convert the key to PKCS#8 first: openssl pkcs8 -topk8 -nocrypt -in key.ec.pem -out key.pem');
  }
  if (key.alg === 'HS256') throw invalid('signingKey.alg is HS256, but privateKey is a PEM');
  const der = pemBody(material);
  const candidates: ('EdDSA' | 'ES256')[] = key.alg ? [key.alg] : ['EdDSA', 'ES256'];
  let lastError: unknown;
  for (const alg of candidates) {
    try {
      return make(alg, await subtle.importKey('pkcs8', der, IMPORT[alg], false, ['sign']));
    } catch (e) {
      lastError = e;
    }
  }
  throw invalid('signingKey.privateKey is not an Ed25519 or P-256 private key in PKCS#8 PEM', lastError);
}

/** A compact JWT: `kid` and `alg` in the header, `claims` as the payload. */
export async function signJwt(signer: Signer, claims: Record<string, unknown>): Promise<string> {
  const header = { alg: signer.alg, kid: signer.kid, typ: 'JWT' };
  const input = `${base64Url(enc.encode(JSON.stringify(header)))}.${base64Url(enc.encode(JSON.stringify(claims)))}`;
  const signature = await signer.sign(enc.encode(input));
  return `${input}.${base64Url(signature)}`;
}
