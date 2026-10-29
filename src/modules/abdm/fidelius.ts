import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// ABDM's health-information encryption ("Fidelius"), HIP side.
//
//   shared  = x-coordinate of ECDH on Curve25519 in short Weierstrass form
//             (BouncyCastle's "curve25519" - not X25519), 32 bytes
//   xor     = ourNonce XOR hiuNonce (32 bytes each)
//   aesKey  = HKDF-SHA256(ikm = shared, salt = xor[0..20], no info, 32 bytes)
//   content = base64(AES-256-GCM(iv = xor[20..32]) ciphertext || 128-bit tag)
//
// Node's OpenSSL has no ECDH on this curve form, so the curve arithmetic is
// done here with BigInt. It is checked against Node's X25519 through the
// Montgomery <-> Weierstrass map in test/fidelius.test.ts.
//
// Keys travel base64-encoded either as a raw uncompressed point (65 bytes,
// 0x04||X||Y) or as an X.509 SubjectPublicKeyInfo with explicit curve
// parameters (what Fidelius emits as x509PublicKey). We answer in the
// encoding the HIU used.

type Point = { x: bigint; y: bigint } | null; // null = point at infinity

const P = 2n ** 255n - 19n;
const MONT_A = 486662n;

const mod = (v: bigint) => ((v % P) + P) % P;
function powMod(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}
const inv = (v: bigint) => powMod(v, P - 2n);

// v² = u³ + A·u² + u  maps to  y² = x³ + a·x + b  with x = u + A/3, y = v.
export const CURVE = {
  p: P,
  a: mod((3n - MONT_A * MONT_A) * inv(3n)),
  b: mod((2n * MONT_A ** 3n - 9n * MONT_A) * inv(27n)),
  // Base point u = 9.
  G: {
    x: mod(9n + MONT_A * inv(3n)),
    y: 0x20ae19a1b8a086b4e01edd2c7748d14c923d4d7e6d7c61b229e9c5a27eced3d9n,
  },
  n: 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn, // order of G
};
export const montgomeryU = (x: bigint) => mod(x - MONT_A * inv(3n));

export const onCurve = (pt: Point) =>
  pt !== null && pt.x < P && pt.y < P && mod(pt.y * pt.y - (pt.x ** 3n + CURVE.a * pt.x + CURVE.b)) === 0n;

// Jacobian coordinates (x = X/Z², y = Y/Z³; Z = 0 is infinity): no modular
// inversion per step, one at the end.
type Jacobian = { X: bigint; Y: bigint; Z: bigint };
const INFINITY: Jacobian = { X: 1n, Y: 1n, Z: 0n };

function double(p: Jacobian): Jacobian {
  if (p.Z === 0n || p.Y === 0n) return INFINITY;
  const yy = mod(p.Y * p.Y);
  const s = mod(4n * p.X * yy);
  const zz = mod(p.Z * p.Z);
  const m = mod(3n * p.X * p.X + CURVE.a * zz * zz);
  const X = mod(m * m - 2n * s);
  return { X, Y: mod(m * (s - X) - 8n * yy * yy), Z: mod(2n * p.Y * p.Z) };
}

function add(p: Jacobian, q: Jacobian): Jacobian {
  if (p.Z === 0n) return q;
  if (q.Z === 0n) return p;
  const pz2 = mod(p.Z * p.Z);
  const qz2 = mod(q.Z * q.Z);
  const u1 = mod(p.X * qz2);
  const u2 = mod(q.X * pz2);
  const s1 = mod(p.Y * qz2 * q.Z);
  const s2 = mod(q.Y * pz2 * p.Z);
  if (u1 === u2) return s1 === s2 ? double(p) : INFINITY;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(hh * h);
  const X = mod(r * r - hhh - 2n * u1 * hh);
  return { X, Y: mod(r * (u1 * hh - X) - s1 * hhh), Z: mod(h * p.Z * q.Z) };
}

// Montgomery ladder: the same sequence of operations for every bit.
export function multiply(k: bigint, pt: Point): Point {
  if (!pt) return null;
  let r0 = INFINITY;
  let r1: Jacobian = { X: pt.x, Y: pt.y, Z: 1n };
  for (let i = BigInt(k.toString(2).length) - 1n; i >= 0n; i--) {
    if ((k >> i) & 1n) {
      r0 = add(r0, r1);
      r1 = double(r1);
    } else {
      r1 = add(r0, r1);
      r0 = double(r0);
    }
  }
  if (r0.Z === 0n) return null;
  const zInv = inv(r0.Z);
  const zInv2 = mod(zInv * zInv);
  return { x: mod(r0.X * zInv2), y: mod(r0.Y * zInv2 * zInv) };
}

const toBytes = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const toBigInt = (b: Buffer) => BigInt(`0x${b.toString("hex") || "0"}`);

const encodePoint = (pt: Point) => Buffer.concat([Buffer.from([4]), toBytes(pt!.x), toBytes(pt!.y)]);

export interface DecodedKey {
  point: Point;
  // The HIU's X.509 bytes, reused as the template for our key; null = raw.
  x509Template: Buffer | null;
}

export function decodePublicKey(base64: string): DecodedKey {
  const der = Buffer.from(base64, "base64");
  let raw: Buffer;
  let x509Template: Buffer | null = null;
  if (der.length === 65) {
    raw = der;
  } else {
    // SubjectPublicKeyInfo ends with BIT STRING { 0 unused bits, 04||X||Y }.
    // Its parameters must be Curve25519's: the prime appears in them.
    if (der.length < 67 || der[der.length - 66] !== 0 || !der.includes(toBytes(P))) {
      throw new Error("HIU public key is not a Curve25519 key");
    }
    raw = der.subarray(der.length - 65);
    x509Template = der;
  }
  if (raw[0] !== 4) throw new Error("HIU public key is not an uncompressed point");
  const point = { x: toBigInt(raw.subarray(1, 33)), y: toBigInt(raw.subarray(33)) };
  // Rejects invalid-curve points (would leak our ephemeral key).
  if (!onCurve(point)) throw new Error("HIU public key is not on Curve25519");
  return { point, x509Template };
}

function encodePublicKey(pt: Point, template: Buffer | null): string {
  const raw = encodePoint(pt);
  return (template ? Buffer.concat([template.subarray(0, template.length - 65), raw]) : raw).toString("base64");
}

function randomScalar(): bigint {
  // 64 random bytes reduced mod n-1: negligible bias.
  return (toBigInt(randomBytes(64)) % (CURVE.n - 1n)) + 1n;
}

function aesKeyAndIv(sharedX: bigint, ourNonce: Buffer, theirNonce: Buffer) {
  if (ourNonce.length !== 32 || theirNonce.length !== 32) throw new Error("nonces must be 32 bytes");
  const xor = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) xor[i] = ourNonce[i] ^ theirNonce[i];
  const key = Buffer.from(hkdfSync("sha256", toBytes(sharedX), xor.subarray(0, 20), Buffer.alloc(0), 32));
  return { key, iv: xor.subarray(20) };
}

export interface HiuKeyMaterial {
  dhPublicKey: { keyValue: string };
  nonce: string; // base64, 32 bytes
}

/**
 * Encrypts one payload for the HIU with a fresh ephemeral key and nonce, and
 * returns the keyMaterial to send with it. Fresh per payload because key and
 * IV are both derived from the key material - reusing it would reuse a GCM IV.
 */
export function encryptForHiu(plaintext: string, hiu: HiuKeyMaterial, keyExpiry: Date) {
  const their = decodePublicKey(hiu.dhPublicKey.keyValue);
  const d = randomScalar();
  const shared = multiply(d, their.point);
  if (!shared) throw new Error("degenerate shared secret");
  const nonce = randomBytes(32);
  const { key, iv } = aesKeyAndIv(shared.x, nonce, Buffer.from(hiu.nonce, "base64"));

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const content = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");

  return {
    content,
    keyMaterial: {
      cryptoAlg: "ECDH",
      curve: "Curve25519",
      dhPublicKey: {
        expiry: keyExpiry.toISOString(),
        parameters: "Curve25519/32byte random key",
        keyValue: encodePublicKey(multiply(d, CURVE.G), their.x509Template),
      },
      nonce: nonce.toString("base64"),
    },
  };
}

// ── HIU side - used by tests to prove a transfer can be read ──────────────

export function generateKeyPair() {
  const d = randomScalar();
  return { privateKey: d, publicKey: encodePoint(multiply(d, CURVE.G)).toString("base64") };
}

export function decryptFromHip(content: string, hipKeyValue: string, hipNonce: string, privateKey: bigint, ownNonce: string) {
  const shared = multiply(privateKey, decodePublicKey(hipKeyValue).point)!;
  const { key, iv } = aesKeyAndIv(shared.x, Buffer.from(hipNonce, "base64"), Buffer.from(ownNonce, "base64"));
  const data = Buffer.from(content, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
}
