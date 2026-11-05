import { env } from "../../lib/env";

// The Health Partner service's internal referral API (hp: routes/internal.routes.ts).
// Every call there is idempotent, so any of these can be retried.

export const hpConfigured = () => Boolean(env.hp.serviceUrl);

/** No usable answer (not configured, unreachable, timed out, 5xx) - try again later. */
export class HpUnavailable extends Error {}

/** HP answered 4xx: it will give the same answer again, so don't retry. */
export interface HpRefusal {
  refused: true;
  status: number;
  code: string;
  message: string;
}

type Result<T> = ({ refused: false } & T) | HpRefusal;

async function call<T>(method: "GET" | "POST", path: string, body?: object): Promise<Result<T>> {
  if (!hpConfigured()) throw new HpUnavailable("HP_SERVICE_URL is not set");
  let res: Response;
  try {
    res = await fetch(`${env.hp.serviceUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-service-name": "userservice" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(env.hp.timeoutMs),
    });
  } catch (err) {
    throw new HpUnavailable(`HP service unreachable: ${(err as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 500 || res.status === 429) {
    throw new HpUnavailable(`HP service answered ${res.status} ${String(json.code ?? "")}`.trim());
  }
  if (res.status >= 400) {
    return { refused: true, status: res.status, code: String(json.code ?? `HTTP_${res.status}`), message: String(json.message ?? "") };
  }
  return { refused: false, ...(json as T) };
}

const enc = encodeURIComponent;

/** Would HP accept this code for this patient? Read-only. */
export const checkCode = (code: string, userId: string) =>
  call<{ valid: true }>("GET", `/internal/v1/referral-codes/${enc(code)}?referredUserId=${enc(userId)}`);

/** Patient signed up with the code: PENDING at HP, no reward. */
export const registerReferral = (code: string, userId: string) =>
  call<{ status: string }>("POST", "/internal/v1/referrals", { referralCode: code, referredUserId: userId });

/** Patient's own ABHA linked: HP marks it COMPLETED and pays the HP (once). */
export const completeReferral = (code: string, userId: string) =>
  call<{ credited: boolean }>("POST", "/internal/v1/referrals/complete", { referralCode: code, referredUserId: userId });

/** A PENDING referral that will never complete. */
export const cancelReferral = (userId: string) =>
  call<{ status: string | null }>("POST", "/internal/v1/referrals/cancel", { referredUserId: userId });
