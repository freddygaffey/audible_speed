import path from "node:path";
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? "info";

const resolvedLogFile = process.env.LOG_FILE?.trim().length
  ? path.resolve(process.env.LOG_FILE)
  : path.resolve(process.cwd(), "logs", "api-server.log");

const targets: pino.TransportTargetOptions[] = [
  // Keep structured stdout logs in production.
  ...(isProduction
    ? [{ target: "pino/file", options: { destination: 1 } }]
    : [
        {
          target: "pino-pretty",
          options: { colorize: true },
        },
      ]),
  // Also persist logs to disk for easier debugging after restarts/crashes.
  {
    target: "pino/file",
    level,
    options: {
      destination: resolvedLogFile,
      mkdir: true,
    },
  },
];

export const logger = pino({
  level,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  transport: {
    targets,
  },
});
