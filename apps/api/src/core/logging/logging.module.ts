import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

export const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "*.apiKey",
  "*.cpf",
  "*.email",
  "*.phone",
];

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        genReqId: (req, res) => {
          const existing = req.headers["x-request-id"];
          const id = typeof existing === "string" && existing.length > 0 ? existing : randomUUID();
          res.setHeader("x-request-id", id);
          return id;
        },
        redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
        level: process.env["LOG_LEVEL"] ?? "info",
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
