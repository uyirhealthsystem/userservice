// One-off move of patient profiles + family members out of authservice.
//
//   AUTH_DATABASE_URL=<authservice db> npm run import:authservice [-- --dry-run]
//
// Reads authservice's patient_profiles / family_members (read-only) and writes
// them here with their ids unchanged - homebasedcare bookings reference family
// member ids. Each patient that has either gets a users row, so existing
// patients are not sent through onboarding again. Patient numbers are handed
// out in order of the patient's earliest record.
//
// Safe to re-run: rows already copied are skipped. Ends by checking every
// source id exists here, and exits non-zero if any is missing. Only after a
// clean run should authservice drop its two tables.
import { Client } from "pg";
import { prisma } from "../lib/prisma";

interface ProfileRow {
  id: string;
  userId: string;
  fullName: string;
  dateOfBirth: Date | null;
  gender: string | null;
  phone: string | null;
  bloodGroup: string | null;
  address: string | null;
  district: string | null;
  pinCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FamilyRow extends Omit<ProfileRow, "address"> {
  relationship: string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sourceUrl = process.env.AUTH_DATABASE_URL;
  if (!sourceUrl) throw new Error("Set AUTH_DATABASE_URL to authservice's database.");

  const source = new Client({ connectionString: sourceUrl });
  await source.connect();
  try {
    const profiles = (await source.query<ProfileRow>('SELECT * FROM "patient_profiles" ORDER BY "createdAt"')).rows;
    const family = (await source.query<FamilyRow>('SELECT * FROM "family_members" ORDER BY "createdAt"')).rows;

    // Earliest record first, so patient numbers follow sign-up order.
    const firstSeen = new Map<string, Date>();
    for (const r of [...profiles, ...family]) {
      const seen = firstSeen.get(r.userId);
      if (!seen || r.createdAt < seen) firstSeen.set(r.userId, r.createdAt);
    }
    const userIds = [...firstSeen.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()).map(([id]) => id);

    console.log(`source: ${userIds.length} patients, ${profiles.length} profiles, ${family.length} family members`);
    if (dryRun) {
      console.log("--dry-run: nothing written");
      return;
    }

    // One by one, not createMany: autoincrement order must match userIds.
    let newUsers = 0;
    for (const id of userIds) {
      const existed = await prisma.user.findUnique({ where: { id }, select: { id: true } });
      if (existed) continue;
      await prisma.user.create({ data: { id, createdAt: firstSeen.get(id) } });
      newUsers++;
    }
    const p = await prisma.patientProfile.createMany({ data: profiles, skipDuplicates: true });
    const f = await prisma.familyMember.createMany({ data: family, skipDuplicates: true });
    console.log(`written: ${newUsers} users, ${p.count} profiles, ${f.count} family members (rest already present)`);

    // Verify by id, not by count - a count could match by coincidence.
    const haveProfiles = new Set(
      (await prisma.patientProfile.findMany({ where: { id: { in: profiles.map((r) => r.id) } }, select: { id: true } })).map((r) => r.id),
    );
    const haveFamily = new Set(
      (await prisma.familyMember.findMany({ where: { id: { in: family.map((r) => r.id) } }, select: { id: true } })).map((r) => r.id),
    );
    const missing = [
      ...profiles.filter((r) => !haveProfiles.has(r.id)).map((r) => `profile ${r.id}`),
      ...family.filter((r) => !haveFamily.has(r.id)).map((r) => `family member ${r.id}`),
    ];
    if (missing.length > 0) {
      console.error(`MISSING after import (${missing.length}):\n  ${missing.join("\n  ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("verified: every source profile and family member is present");
  } finally {
    await source.end();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
