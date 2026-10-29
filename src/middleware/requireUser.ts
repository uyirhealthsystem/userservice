import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { Errors } from "../lib/errors";

// For every route that needs the patient to have created their profile
// first. Runs after gatewayIdentity. 404 PROFILE_REQUIRED tells the app to
// show its onboarding screen.
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { status: true } });
    if (!user) throw Errors.profileRequired();
    if (user.status === "DISABLED") throw Errors.accountDisabled();
    next();
  } catch (err) {
    next(err);
  }
}
