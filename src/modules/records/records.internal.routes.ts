import { Router } from "express";
import express from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { Errors } from "../../lib/errors";
import { serviceAuth } from "../../middleware/gatewayIdentity";
import { healthRecordInputSchema } from "./records.schemas";
import { IngestRejected, ingestHealthRecord, recordRejection } from "./records.ingest";

// Producers push records here when they don't use Kafka. Mounted at
// /internal/v1 - outside /api/v1/users, so the api-gateway never forwards to
// it - and ahead of the app-wide JSON parser, so the token is checked before
// a (possibly large) body is read. Each producer has its own bearer token
// (INTERNAL_SERVICE_TOKENS) and can only write records of its own source.
export const internalRecordsRouter = Router();

// Bigger than the app-wide JSON limit: attachments may come inline.
const jsonWithFiles = express.json({ limit: "25mb" });

internalRecordsRouter.post(
  "/health-records",
  serviceAuth,
  jsonWithFiles,
  asyncHandler(async (req, res) => {
    const source = res.locals.source as string;
    try {
      const input = healthRecordInputSchema.parse(req.body);
      if (input.source !== source) {
        throw new IngestRejected("SOURCE_MISMATCH", `This token may only send records with source ${source}.`);
      }
      const { outcome, recordId } = await ingestHealthRecord(input, "HTTP");
      res.status(outcome === "created" ? 201 : 200).json({ outcome, recordId });
    } catch (err) {
      if (err instanceof ZodError) {
        await recordRejection("HTTP", `VALIDATION_ERROR: ${err.message}`, req.body);
        throw err;
      }
      if (err instanceof IngestRejected) {
        await recordRejection("HTTP", `${err.code}: ${err.message}`, req.body);
        throw Errors.unprocessable(err.code, err.message);
      }
      throw err;
    }
  }),
);
