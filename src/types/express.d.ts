// The caller's identity, as asserted by the api-gateway (x-user-id /
// x-user-role) and checked by middleware/gatewayIdentity.ts. Only routes
// behind that middleware populate this - everywhere else it is undefined.
import "express";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: string;
      };
    }
  }
}
