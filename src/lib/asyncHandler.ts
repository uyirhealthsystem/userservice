import { NextFunction, Request, Response } from "express";

// Express 5 (used here) already forwards a rejected promise from an async
// route handler to the error middleware on its own. This wrapper is kept
// anyway for explicitness and so every route reads the same way regardless
// of framework version.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
