import { vi } from "vitest";
import { env } from "../src/lib/env";

// A stand-in for the Health Partner service's internal referral API (hp:
// src/services/citizen-referral.service.ts), with the same rules: codes match
// case-insensitively, a user is referred once, complete pays once. Installed
// over whatever fetch is already there (the fake ABDM), handling only its
// own host.

export const HP_URL = "https://hp.test";

export interface FakeReferral {
  code: string;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
}

export function installFakeHp(codes: Record<string, string> = { HPRAVI001: "hp-user-ravi" }) {
  const referrals = new Map<string, FakeReferral>(); // by referred user id
  const wallet: Record<string, number> = {}; // by code
  const calls: { method: string; path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const state = { down: false, delayMs: 0 }; // delayMs: a slow HP (honours the caller's timeout)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number, code: string) => json({ code, message: code }, status);

  const referrer = (code: string, userId: string) => {
    const canonical = Object.keys(codes).find((c) => c.toUpperCase() === code.toUpperCase());
    if (!canonical) return fail(404, "INVALID_REFERRAL_CODE");
    if (codes[canonical] === userId) return fail(400, "SELF_REFERRAL");
    return canonical;
  };

  const previous = globalThis.fetch;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== HP_URL) return previous(input, init);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (state.down) throw new Error("connect ECONNREFUSED");
    if (state.delayMs) {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, state.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    }

    const codeCheck = url.pathname.match(/^\/internal\/v1\/referral-codes\/(.+)$/);
    if (codeCheck) {
      const r = referrer(decodeURIComponent(codeCheck[1]), url.searchParams.get("referredUserId") ?? "");
      return typeof r === "string" ? json({ valid: true }) : r;
    }
    const existing = body?.referredUserId ? referrals.get(body.referredUserId) : undefined;
    const sameCode = existing && existing.code.toUpperCase() === String(body.referralCode ?? "").toUpperCase();
    switch (url.pathname) {
      case "/internal/v1/referrals": {
        if (existing) return sameCode ? json(existing) : fail(409, "ALREADY_REFERRED");
        const r = referrer(body.referralCode, body.referredUserId);
        if (typeof r !== "string") return r;
        referrals.set(body.referredUserId, { code: r, status: "PENDING" });
        return json(referrals.get(body.referredUserId), 201);
      }
      case "/internal/v1/referrals/complete": {
        if (existing) {
          if (!sameCode) return fail(409, "ALREADY_REFERRED");
          if (existing.status === "COMPLETED") return json({ referral: existing, credited: false });
          if (existing.status === "CANCELLED") return fail(409, "REFERRAL_CANCELLED");
          existing.status = "COMPLETED";
          wallet[existing.code] = (wallet[existing.code] ?? 0) + 10;
          return json({ referral: existing, credited: true });
        }
        const r = referrer(body.referralCode, body.referredUserId);
        if (typeof r !== "string") return r;
        referrals.set(body.referredUserId, { code: r, status: "COMPLETED" });
        wallet[r] = (wallet[r] ?? 0) + 10;
        return json({ referral: referrals.get(body.referredUserId), credited: true });
      }
      case "/internal/v1/referrals/cancel": {
        if (existing?.status === "PENDING") existing.status = "CANCELLED";
        return json({ status: existing?.status ?? null });
      }
    }
    return fail(404, "NOT_FOUND");
  });
  vi.stubGlobal("fetch", fetchMock);
  env.hp.serviceUrl = HP_URL;

  return {
    referrals,
    wallet,
    calls,
    state,
    callsTo: (path: string) => calls.filter((c) => c.path === path),
  };
}
