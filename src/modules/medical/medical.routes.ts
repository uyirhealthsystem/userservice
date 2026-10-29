import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { audit } from "../../lib/audit";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { consentedMember, consentedSubjects } from "../privacy/consent.service";
import { idParamSchema } from "../family/family.schemas";
import {
  listQuerySchema,
  createConditionSchema,
  updateConditionSchema,
  createAllergySchema,
  updateAllergySchema,
  createMedicationSchema,
  updateMedicationSchema,
  createVitalSchema,
} from "./medical.schemas";

// The patient's medical records, for themself or a family member. Every
// resource has the same shape (list / create / update / delete, scoped to the
// caller's account), so the routes are generated from the table below.
// Mounted behind gatewayIdentity(PATIENT) + requireUser + requireConsent.
// A family member's records are only processed with consent for them (a
// delete always works). Every access is written to access_audit.

// The slice of a Prisma model delegate these routes use.
interface Delegate {
  findMany(args: object): Promise<unknown[]>;
  findFirst(args: object): Promise<unknown>;
  create(args: object): Promise<{ id: string }>;
  update(args: object): Promise<unknown>;
  delete(args: object): Promise<unknown>;
}

interface Resource {
  path: string; // URL segment, response key for a list, and audit resource name
  one: string; // response key for a single record
  label: string; // for 404 messages
  model: Delegate;
  orderBy: object;
  create: z.ZodType<{ familyMemberId?: string | null }>;
  update?: z.ZodType<object>; // omitted = records can't be edited (vitals)
}

const resources: Resource[] = [
  {
    path: "conditions",
    one: "condition",
    label: "Condition",
    model: prisma.medicalCondition,
    orderBy: { createdAt: "desc" },
    create: createConditionSchema,
    update: updateConditionSchema,
  },
  {
    path: "allergies",
    one: "allergy",
    label: "Allergy",
    model: prisma.allergy,
    orderBy: { createdAt: "desc" },
    create: createAllergySchema,
    update: updateAllergySchema,
  },
  {
    path: "medications",
    one: "medication",
    label: "Medication",
    model: prisma.medication,
    orderBy: { createdAt: "desc" },
    create: createMedicationSchema,
    update: updateMedicationSchema,
  },
  {
    path: "vitals",
    one: "vital",
    label: "Vital reading",
    model: prisma.vitalReading,
    orderBy: { measuredAt: "desc" },
    create: createVitalSchema,
  },
];

// userId is always the caller - never echoed back.
const omit = { userId: true };

export const medicalRouter = Router();

for (const r of resources) {
  const base = `/me/medical/${r.path}`;

  // 404 (not 403) for a record on another account, so ids can't be probed.
  // consented: only records whose subject has consent (for a change).
  const owned = async (userId: string, id: string, consented = false) => {
    const where = { id, userId, ...(consented && (await consentedSubjects(userId))) };
    const row = await r.model.findFirst({ where, select: { id: true } });
    if (!row) throw Errors.notFound(r.label);
  };

  medicalRouter.get(
    base,
    asyncHandler(async (req, res) => {
      const userId = req.auth!.userId;
      const { memberId } = listQuerySchema.parse(req.query);
      if (memberId && memberId !== "self") await consentedMember(userId, memberId);
      const where =
        memberId === undefined
          ? { userId, ...(await consentedSubjects(userId)) }
          : { userId, familyMemberId: memberId === "self" ? null : memberId };
      const rows = await r.model.findMany({ where, omit, orderBy: r.orderBy });
      await audit(req, "READ", r.path);
      res.status(200).json({ [r.path]: rows });
    }),
  );

  medicalRouter.post(
    base,
    asyncHandler(async (req, res) => {
      const userId = req.auth!.userId;
      const body = r.create.parse(req.body);
      if (body.familyMemberId) await consentedMember(userId, body.familyMemberId);
      const row = await r.model.create({ data: { ...body, userId }, omit });
      await audit(req, "CREATE", r.path, row.id);
      res.status(201).json({ [r.one]: row });
    }),
  );

  const update = r.update;
  if (update) {
    medicalRouter.patch(
      `${base}/:id`,
      asyncHandler(async (req, res) => {
        const userId = req.auth!.userId;
        const { id } = idParamSchema.parse(req.params);
        const body = update.parse(req.body);
        await owned(userId, id, true);
        const row = await r.model.update({ where: { id }, data: body, omit });
        await audit(req, "UPDATE", r.path, id);
        res.status(200).json({ [r.one]: row });
      }),
    );
  }

  medicalRouter.delete(
    `${base}/:id`,
    asyncHandler(async (req, res) => {
      const userId = req.auth!.userId;
      const { id } = idParamSchema.parse(req.params);
      await owned(userId, id);
      await r.model.delete({ where: { id } });
      await audit(req, "DELETE", r.path, id);
      res.status(204).end();
    }),
  );
}
