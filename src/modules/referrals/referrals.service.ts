import { createHmac } from "node:crypto";
import { Prisma, PatientReferral } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../lib/env";
import { Errors } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { backoff, claimDue } from "../../lib/jobs";
import {
  HpRefusal,
  HpUnavailable,
  cancelReferral,
  checkCode,
  completeReferral,
  hpConfigured,
  registerReferral,
} from "./hp.client";

// Health Partner referrals (docs/referrals.md). A patient may give an HP's
// referral code when creating their profile. The HP earns the reward only
// once that patient's own ABHA is linked here - the point at which ABDM has
// verified them as a real person (OTP + matching demographics). The HP
// service owns the referral and the reward; we tell it, through the
// patient_referrals outbox, when each step happens.

export type ReferralStatus = "UNREGISTERED" | "PENDING" | "QUALIFIED" | "COMPLETED" | "CANCELLING" | "INVALID";

/**
 * At signup, before anything is stored: refuses a code the HP service says
 * is wrong, so the patient can correct it. HP down or not configured = the
 * code is accepted unchecked (signup never waits on another service); the
 * worker sends it later, and drops it then if HP refuses it.
 */
export async function assertReferralCodeAccepted(userId: string, code: string) {
  if (!hpConfigured()) return;
  try {
    const result = await checkCode(code, userId);
    if (result.refused) {
      throw Errors.badRequest(
        "INVALID_REFERRAL_CODE",
        result.code === "SELF_REFERRAL"
          ? "You cannot use your own referral code."
          : "This referral code is not valid. Check it with your Health Partner, or leave it empty.",
      );
    }
  } catch (err) {
    if (!(err instanceof HpUnavailable)) throw err;
    logger.warn({ err: err.message }, "referral code not checked: HP service unavailable; accepted for later");
  }
}

/**
 * In the profile-creation transaction. A row left from an erased account
 * with the same id (HP not told yet) is kept: HP refers a user once, ever.
 */
export function recordReferral(tx: Prisma.TransactionClient, userId: string, code: string) {
  return tx.patientReferral.createMany({
    data: [{ userId, code, status: "UNREGISTERED" satisfies ReferralStatus }],
    skipDuplicates: true,
  });
}

/** Keyed hash of an ABHA number - lets us refuse a second reward without keeping the number. */
export function abhaHash(abhaNumber: string) {
  // DATA_ENCRYPTION_KEY is required in production. A rotation must keep
  // using the old key here, or rewarded ABHAs could earn again.
  const key = env.dataEncryptionKey ?? Buffer.from("uyir-dev-only-referral-key");
  return createHmac("sha256", key).update(`referral-abha:${abhaNumber}`).digest("hex");
}

/**
 * In the transaction that links an ABHA: when it is the patient's own ABHA
 * and they signed up with a referral code, the referral qualifies - the
 * worker then has HP pay the reward. An ABHA that already earned a reward
 * (unlinked and linked to another account since) never earns a second one:
 * that referral is cancelled instead.
 */
export async function qualifyReferral(tx: Prisma.TransactionClient, userId: string, subject: string, abhaNumber: string) {
  if (subject !== "self") return;
  const referral = await tx.patientReferral.findUnique({ where: { userId } });
  if (!referral || (referral.status !== "UNREGISTERED" && referral.status !== "PENDING")) return;

  // ON CONFLICT DO NOTHING: a failed insert would abort the whole link.
  const { count } = await tx.rewardedAbha.createMany({ data: [{ abhaHash: abhaHash(abhaNumber) }], skipDuplicates: true });
  const now = new Date();
  await tx.patientReferral.update({
    where: { userId },
    data:
      count === 1
        ? { status: "QUALIFIED", qualifiedAt: now, attempts: 0, lastError: null, nextAttemptAt: now }
        : { status: "CANCELLING", reason: "ABHA_ALREADY_REWARDED", attempts: 0, lastError: null, nextAttemptAt: now },
  });
}

/**
 * In the erasure transaction. HP keeps its own referral (a pseudonymous user
 * id) for its accounts; we only make sure it hears what it still must:
 * a qualified referral is still paid, an unpaid one is cancelled. The row is
 * deleted once HP has been told.
 */
export async function onAccountErased(tx: Prisma.TransactionClient, userId: string) {
  const referral = await tx.patientReferral.findUnique({ where: { userId } });
  if (!referral) return;
  switch (referral.status as ReferralStatus) {
    case "COMPLETED":
    case "INVALID":
      await tx.patientReferral.delete({ where: { userId } });
      return;
    case "QUALIFIED":
    case "CANCELLING":
      return;
    case "UNREGISTERED": // a register may have reached HP even if we never saw the answer
    case "PENDING":
      await tx.patientReferral.update({
        where: { userId },
        data: { status: "CANCELLING", reason: "ACCOUNT_ERASED", attempts: 0, lastError: null, nextAttemptAt: new Date() },
      });
  }
}

/** For the data export. */
export function referralForExport(userId: string) {
  return prisma.patientReferral.findUnique({
    where: { userId },
    select: { code: true, status: true, qualifiedAt: true, createdAt: true },
  });
}

// ── Worker ──────────────────────────────────────────────────────────────────

const DUE: ReferralStatus[] = ["UNREGISTERED", "QUALIFIED", "CANCELLING"];
const BATCH = 20;

// The batch is sent in parallel, so a round takes about one HP call however
// slow HP is (each call is cut off at HP_TIMEOUT_MS) - it never holds up the
// worker's other steps (ABDM linking, data transfers) for BATCH timeouts.
// The lease outlasts such a round with room to spare, so another replica
// doesn't pick the same rows up mid-flight.
const leaseSeconds = () => Math.max(60, Math.ceil((env.hp.timeoutMs * 4) / 1000));

/** Sends what HP has not heard yet. Does nothing until HP_SERVICE_URL is set. */
export async function processReferrals() {
  if (!hpConfigured()) return;
  const due = await claimDue("referrals", DUE, BATCH, leaseSeconds());
  await Promise.all(due.map(deliverOne));
}

async function deliverOne(userId: string) {
  const referral = await prisma.patientReferral.findUnique({ where: { userId } });
  if (!referral || !DUE.includes(referral.status as ReferralStatus)) return;
  try {
    await deliver(referral);
  } catch (err) {
    if (!(err instanceof HpUnavailable)) logger.error({ err, userId }, "referral delivery failed");
    const attempts = referral.attempts + 1;
    // Only if nothing moved the row on meanwhile (e.g. qualified while we registered).
    await prisma.patientReferral
      .updateMany({
        where: { userId, status: referral.status },
        data: { attempts, lastError: (err as Error).message.slice(0, 500), nextAttemptAt: backoff(attempts) },
      })
      .catch((dbErr) => logger.error({ err: dbErr, userId }, "referral retry not recorded; retried when the lease ends"));
  }
}

async function deliver(referral: PatientReferral) {
  const { userId, code } = referral;
  switch (referral.status as ReferralStatus) {
    case "UNREGISTERED": {
      const result = await registerReferral(code, userId);
      return settle(referral, result.refused ? invalid(result) : { status: "PENDING" });
    }
    case "QUALIFIED": {
      const result = await completeReferral(code, userId);
      return settle(referral, result.refused ? invalid(result) : { status: "COMPLETED" }, true);
    }
    case "CANCELLING":
      // A refusal here can only mean there is nothing to cancel.
      await cancelReferral(userId);
      return settle(referral, { status: "INVALID" }, true);
  }
}

function invalid(refusal: HpRefusal): Prisma.PatientReferralUpdateManyMutationInput {
  logger.warn({ code: refusal.code, status: refusal.status }, "HP refused a referral");
  return { status: "INVALID", reason: refusal.code };
}

/**
 * Records HP's answer, unless the row changed meanwhile. A finished row of an
 * erased account (`dropIfErased`) is deleted - HP has heard all it needs.
 */
async function settle(referral: PatientReferral, data: Prisma.PatientReferralUpdateManyMutationInput, dropIfErased = false) {
  const { userId } = referral;
  if (dropIfErased && !(await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) {
    await prisma.patientReferral.deleteMany({ where: { userId, status: referral.status } });
    return;
  }
  await prisma.patientReferral.updateMany({
    where: { userId, status: referral.status },
    data: { ...data, attempts: 0, lastError: null },
  });
}
