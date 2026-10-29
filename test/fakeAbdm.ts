import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { vi } from "vitest";

// A stand-in for ABDM's ABHA and HIE-CM APIs (and an HIU's dataPushUrl),
// installed as global fetch. Records every call for assertions.

export const HIU_PUSH_URL = "https://hiu.test/data/push";

export interface Call {
  path: string;
  headers: Record<string, string>;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function installFakeAbdm(profile: Record<string, unknown>) {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificate = rsa.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const decrypt = (b64: string) =>
    privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(b64, "base64")).toString();
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.origin === "https://hiu.test" ? url.href : url.pathname, headers: (init?.headers ?? {}) as Record<string, string>, body });

    switch (url.pathname) {
      case "/api/hiecm/gateway/v3/sessions":
        return json({ accessToken: "gateway-token", expiresIn: 1200 });
      case "/abha/api/v3/profile/public/certificate":
        return json({ publicKey: certificate });
      case "/abha/api/v3/profile/login/request/otp":
        return decrypt(body.loginId) === String(profile.ABHANumber).replace(/-/g, "")
          ? json({ txnId: "txn-1", message: "OTP sent" })
          : json({ message: "User not found." }, 404);
      case "/abha/api/v3/profile/login/verify":
        return decrypt(body.authData.otp.otpValue) === "123456"
          ? json({ authResult: "success", token: "x-token" })
          : json({ message: "Invalid OTP" }, 400);
      case "/abha/api/v3/profile/account":
        return json(profile);
    }
    // HIE-CM calls and the HIU push answer 202 with no body.
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    calls,
    to: (path: string) => calls.filter((c) => c.path === path),
  };
}

export const ABHA_PROFILE = {
  ABHANumber: "91-1111-2222-3333",
  preferredAbhaAddress: "ravi@sbx",
  name: "Ravi Kumar",
  gender: "M",
  yearOfBirth: "1990",
  dateOfBirth: "14-05-1990",
};

/** Wait for work scheduled with setImmediate after a response. */
export const flush = () => new Promise((r) => setTimeout(r, 30));
