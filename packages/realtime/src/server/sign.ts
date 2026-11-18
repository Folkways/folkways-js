import { Code } from '../shared/codes';
import { RealtimeError } from '../shared/errors';

/** A segment signing key's algorithm. Both are key pairs: Ed25519 (`EdDSA`) or P-256 (`ES256`). */
export type SigningAlgorithm = 'EdDSA' | 'ES256';

/** One of the segment's signing keys, with its private half. Keep it on your server. */
export interface SigningKey {
  /** The key's id in the segment (its `kid`), as the dashboard shows it. */
  kid: string;
  /**
   * The private key, Ed25519 or P-256, in whichever form you have it:
   * - a PEM: `-----BEGIN PRIVATE KEY-----` (PKCS#8, what the dashboard gives you) or
   *   `-----BEGIN EC PRIVATE KEY-----` (what `openssl ecparam -genkey` writes);
   * - the same PEM on one line with its newlines written as `\n`, as secret stores keep it;
   * - the PEM's base64 body alone, without the `-----BEGIN` lines;
   * - a JWK (object or JSON string) with its private part `d`.
   */
  privateKey: string | JsonWebKey;
  /** Read from `privateKey` when left out. When given, the key must be of this algorithm. */
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

const NOT_A_KEY =
  'signingKey.privateKey is not a private key we can read. Give the Ed25519 or P-256 private key of the key pair (the PEM the dashboard showed when you created the key); shared secrets (HS256) are no longer supported';

export function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const IMPORT: Record<SigningAlgorithm, AlgorithmIdentifier | EcKeyImportParams> = {
  EdDSA: { name: 'Ed25519' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
};

const SIGN: Record<SigningAlgorithm, AlgorithmIdentifier | EcdsaParams> = {
  EdDSA: { name: 'Ed25519' },
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
};

const NAME: Record<SigningAlgorithm, string> = { EdDSA: 'an Ed25519', ES256: 'a P-256' };

// --- DER, just enough to wrap a SEC1 EC key in PKCS#8 ---

function der(tag: number, content: Uint8Array): Uint8Array {
  const n = content.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  const out = new Uint8Array(1 + len.length + n);
  out.set([tag, ...len]);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** AlgorithmIdentifier { id-ecPublicKey, prime256v1 }. */
const P256_ALGORITHM = Uint8Array.from([
  0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
]);

/** PKCS#8 around a SEC1 `ECPrivateKey`, which is what WebCrypto imports. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array<ArrayBuffer> {
  const pkcs8 = der(0x30, concat(Uint8Array.from([0x02, 0x01, 0x00]), P256_ALGORITHM, der(0x04, sec1)));
  return new Uint8Array(pkcs8);
}

/** Standard or URL-safe base64, padded or not, ignoring whitespace. */
function fromBase64(b64: string): Uint8Array<ArrayBuffer> | undefined {
  const clean = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+$/.test(clean) || clean.length % 4 === 1) return undefined;
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * A key and how to import it. `sec1` marks DER that came without its PEM
 * lines, which may be PKCS#8 or a SEC1 EC key: both are tried.
 */
type Material = { kind: 'pkcs8'; der: Uint8Array<ArrayBuffer>; sec1?: boolean } | { kind: 'jwk'; jwk: JsonWebKey };

function readString(raw: string): Material {
  // Secret stores that keep values on one line write the PEM's newlines as \n
  const text = raw.trim().replace(/\\n/g, '\n');
  if (text.startsWith('{')) {
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(text) as JsonWebKey;
    } catch (e) {
      throw invalid('signingKey.privateKey starts with { but is not valid JSON; give a JWK or a PEM', e);
    }
    return { kind: 'jwk', jwk };
  }
  if (text.includes('PUBLIC KEY') || /^(ssh-|ecdsa-sha2-)/.test(text)) {
    throw invalid('signingKey.privateKey is a public key; give the private key (the one the dashboard showed once, or your .pem)');
  }
  const armour = /^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----$/.exec(text);
  if (armour) {
    const [, type, body] = armour;
    const bytes = fromBase64(body!);
    if (!bytes) throw invalid(NOT_A_KEY);
    switch (type) {
      case 'PRIVATE KEY':
        return { kind: 'pkcs8', der: bytes };
      case 'EC PRIVATE KEY':
        return { kind: 'pkcs8', der: sec1ToPkcs8(bytes) };
      case 'ENCRYPTED PRIVATE KEY':
        throw invalid('signingKey.privateKey is encrypted; decrypt it first: openssl pkcs8 -in encrypted.pem -out key.pem');
      case 'OPENSSH PRIVATE KEY':
        throw invalid(
          'signingKey.privateKey is an OpenSSH key, which WebCrypto cannot read; make a PEM key with openssl genpkey -algorithm ed25519 -out key.pem, or generate one in the dashboard',
        );
      default:
        throw invalid(`signingKey.privateKey is a ${type}, not an Ed25519 or P-256 private key`);
    }
  }
  if (text.startsWith('-----BEGIN')) throw invalid(NOT_A_KEY);
  // The PEM's body without its -----BEGIN lines: DER, which always opens with a SEQUENCE (0x30)
  const bytes = fromBase64(text);
  if (!bytes || bytes.length < 32 || bytes[0] !== 0x30) throw invalid(NOT_A_KEY);
  return { kind: 'pkcs8', der: bytes, sec1: true };
}

function readJwk(jwk: JsonWebKey): JsonWebKey {
  if (!jwk.d) throw invalid('signingKey.privateKey is a public JWK (it has no "d"); give the private key');
  if (!((jwk.kty === 'OKP' && jwk.crv === 'Ed25519') || (jwk.kty === 'EC' && jwk.crv === 'P-256'))) {
    throw invalid(`signingKey.privateKey is a ${jwk.kty ?? 'JWK'}${jwk.crv ? ` ${jwk.crv}` : ''} key; signing keys are Ed25519 or P-256`);
  }
  // Only the key itself: an `alg`, `use` or `key_ops` written by another tool must not block the import
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, ...(jwk.y ? { y: jwk.y } : {}), d: jwk.d };
}

async function importAs(subtle: SubtleCrypto, alg: SigningAlgorithm, material: Material): Promise<CryptoKey> {
  if (material.kind === 'jwk') return subtle.importKey('jwk', material.jwk, IMPORT[alg], false, ['sign']);
  try {
    return await subtle.importKey('pkcs8', material.der, IMPORT[alg], false, ['sign']);
  } catch (e) {
    if (alg !== 'ES256' || !material.sec1) throw e;
    return subtle.importKey('pkcs8', sec1ToPkcs8(material.der), IMPORT[alg], false, ['sign']);
  }
}

/**
 * Imports a signing key with WebCrypto, so it works on Node 20+, Deno, Bun
 * and edge runtimes without a JWT library. Works out whether the key is
 * Ed25519 or P-256. ES256 signatures come out as r‖s, which is what JWS expects.
 */
export async function importSigner(key: SigningKey): Promise<Signer> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new RealtimeError(Code.TransportUnavailable, { message: 'WebCrypto (crypto.subtle) is unavailable in this runtime', local: true });
  if ((key.alg as string | undefined) === 'HS256') {
    throw invalid('signingKey.alg HS256 is no longer supported: signing keys are Ed25519 (EdDSA) or P-256 (ES256) key pairs');
  }

  let material = typeof key.privateKey === 'string' ? readString(key.privateKey) : ({ kind: 'jwk', jwk: key.privateKey } as Material);
  if (material.kind === 'jwk') material = { kind: 'jwk', jwk: readJwk(material.jwk) };

  // A JWK says which curve it is; DER is tried as each
  const jwkAlg: SigningAlgorithm | undefined = material.kind === 'jwk' ? (material.jwk.kty === 'OKP' ? 'EdDSA' : 'ES256') : undefined;
  const candidates: SigningAlgorithm[] = jwkAlg ? [jwkAlg] : ['EdDSA', 'ES256'];
  let lastError: unknown;
  for (const alg of candidates) {
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await importAs(subtle, alg, material);
    } catch (e) {
      lastError = e;
      continue;
    }
    if (key.alg && key.alg !== alg) {
      throw invalid(`signingKey.alg is ${key.alg}, but privateKey is ${NAME[alg]} key (${alg}); leave alg out to use the key's own`);
    }
    return {
      alg,
      kid: key.kid,
      sign: async (data) => new Uint8Array(await subtle.sign(SIGN[alg], cryptoKey, data)),
    };
  }
  throw invalid(NOT_A_KEY, lastError);
}

/** A compact JWT: `kid` and `alg` in the header, `claims` as the payload. */
export async function signJwt(signer: Signer, claims: Record<string, unknown>): Promise<string> {
  const header = { alg: signer.alg, kid: signer.kid, typ: 'JWT' };
  const input = `${base64Url(enc.encode(JSON.stringify(header)))}.${base64Url(enc.encode(JSON.stringify(claims)))}`;
  const signature = await signer.sign(enc.encode(input));
  return `${input}.${base64Url(signature)}`;
}
