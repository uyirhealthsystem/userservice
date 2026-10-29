import { createPrivateKey, createPublicKey, diffieHellman, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  CURVE,
  decodePublicKey,
  decryptFromHip,
  encryptForHiu,
  generateKeyPair,
  montgomeryU,
  multiply,
  onCurve,
} from "../src/modules/abdm/fidelius";

const le = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex").reverse().toString("base64url");
const fromLe = (b: Buffer) => BigInt(`0x${Buffer.from(b).reverse().toString("hex")}`);

describe("fidelius (ABDM encryption)", () => {
  it("curve constants are BouncyCastle's curve25519", () => {
    expect(CURVE.a).toBe(0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa984914a144n);
    expect(CURVE.b).toBe(0x7b425ed097b425ed097b425ed097b425ed097b425ed097b4260b5e9c7710c864n);
    expect(CURVE.G.x).toBe(0x2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaad245an);
    expect(onCurve(CURVE.G)).toBe(true);
    expect(multiply(CURVE.n, CURVE.G)).toBeNull();
  });

  it("ECDH agrees with Node's X25519 through the Montgomery map", () => {
    for (let i = 0; i < 3; i++) {
      // X25519 clamps its scalar; use an already-clamped one on both sides.
      const k = randomBytes(32);
      k[0] &= 248;
      k[31] &= 127;
      k[31] |= 64;
      const scalar = fromLe(k);
      const peer = multiply(BigInt(`0x${randomBytes(31).toString("hex")}`), CURVE.G)!;

      const ours = multiply(scalar, peer)!;
      const node = diffieHellman({
        privateKey: createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: k.toString("base64url"), x: "" } as never, format: "jwk" }),
        publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: le(montgomeryU(peer.x)) }, format: "jwk" }),
      });
      expect(fromLe(node)).toBe(montgomeryU(ours.x));
    }
  });

  it("an HIU can decrypt what the HIP encrypted (raw and X.509 keys)", () => {
    const hiu = generateKeyPair();
    const hiuNonce = randomBytes(32).toString("base64");
    const sealed = encryptForHiu('{"resourceType":"Bundle"}', { dhPublicKey: { keyValue: hiu.publicKey }, nonce: hiuNonce }, new Date());
    expect(sealed.keyMaterial.curve).toBe("Curve25519");
    const plain = decryptFromHip(sealed.content, sealed.keyMaterial.dhPublicKey.keyValue, sealed.keyMaterial.nonce, hiu.privateKey, hiuNonce);
    expect(plain).toBe('{"resourceType":"Bundle"}');

    // X.509 with explicit params: a made-up prefix holding the prime, then the point.
    const prime = Buffer.from(CURVE.p.toString(16), "hex");
    const x509 = Buffer.concat([Buffer.from([0x30, 0x81]), prime, Buffer.from([0x03, 0x42, 0x00]), Buffer.from(hiu.publicKey, "base64")]);
    const sealed2 = encryptForHiu("hello", { dhPublicKey: { keyValue: x509.toString("base64") }, nonce: hiuNonce }, new Date());
    const ourKey = Buffer.from(sealed2.keyMaterial.dhPublicKey.keyValue, "base64");
    expect(ourKey.subarray(0, ourKey.length - 65)).toEqual(x509.subarray(0, x509.length - 65));
    expect(decryptFromHip(sealed2.content, sealed2.keyMaterial.dhPublicKey.keyValue, sealed2.keyMaterial.nonce, hiu.privateKey, hiuNonce)).toBe("hello");
  });

  it("rejects a point that is not on the curve", () => {
    const bad = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64");
    expect(() => decodePublicKey(bad)).toThrow(/not on Curve25519/);
  });
});
