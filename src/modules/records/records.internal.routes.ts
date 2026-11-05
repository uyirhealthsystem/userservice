import { Router } from "express";
import express from "express";
import { ZodError } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { Errors } from "../../lib/errors";
import { healthRecordInputSchema } from "./records.schemas";
import { IngestRejected, ingestHealthRecord, recordRejection } from "./records.ingest";

// Producers push records here when they don't use Kafka. Mounted at
// /internal/v1 - outside /api/v1/users, so the api-gateway never forwards to
// it. No token: the record's own `source` says which producer sent it.
export const internalRecordsRouter = Router();

// Bigger than the app-wide JSON limit: attachments may come inline.
const jsonWithFiles = express.json({ limit: "25mb" });

internalRecordsRouter.post(
  "/health-records",
  jsonWithFiles,
  asyncHandler(async (req, res) => {
    try {
      const input = healthRecordInputSchema.parse(req.body);
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
