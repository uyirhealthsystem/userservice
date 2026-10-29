import pino from "pino";
import { env } from "./env";

// pino-http logs request headers: never write credentials to the logs
// (gateway secret, producer / ABDM bearer tokens, cookies).
export const redact = {
  paths: [
    "req.headers.authorization",
    'req.headers["x-gateway-secret"]',
    "req.headers.cookie",
    'res.headers["set-cookie"]',
  ],
  censor: "[REDACTED]",
};

export const logger = pino({
  level: env.logLevel,
  redact,
  transport:
    env.nodeEnv === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});
