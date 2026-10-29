export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  notAuthenticated: () => new AppError(401, "NOT_AUTHENTICATED", "Missing or invalid caller identity."),
  forbidden: (msg = "You do not have permission to do this.") => new AppError(403, "FORBIDDEN", msg),
  accountDisabled: () => new AppError(403, "ACCOUNT_DISABLED", "This account has been disabled."),
  // The caller is a valid patient but has not created their profile yet -
  // the app shows its "Create your profile" screen on this code.
  profileRequired: () =>
    new AppError(404, "PROFILE_REQUIRED", "Create your profile first (POST /api/v1/users/me)."),
  profileExists: () =>
    new AppError(409, "PROFILE_EXISTS", "Profile already exists - use PUT /api/v1/users/me/profile to change it."),
  // DPDP: no processing without consent to the current privacy notice. The
  // app shows the notice and POSTs /me/consents on this code.
  consentRequired: (purpose: string, memberId = "self") =>
    new AppError(
      403,
      "CONSENT_REQUIRED",
      `Consent for ${purpose} (${memberId === "self" ? "yourself" : `family member ${memberId}`}) is required - POST /api/v1/users/me/consents.`,
    ),
  notFound: (what: string) => new AppError(404, "NOT_FOUND", `${what} not found.`),
  badRequest: (code: string, msg: string) => new AppError(400, code, msg),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
  unprocessable: (code: string, msg: string) => new AppError(422, code, msg),
  tooManyRequests: (msg: string) => new AppError(429, "TOO_MANY_REQUESTS", msg),
  // ABDM itself failed / is not reachable / our credentials were refused.
  abdmUnavailable: (msg = "ABDM is unavailable. Try again shortly.") => new AppError(502, "ABDM_UNAVAILABLE", msg),
  abdmNotConfigured: () => new AppError(503, "ABDM_NOT_CONFIGURED", "ABDM is not configured on this server."),
};
