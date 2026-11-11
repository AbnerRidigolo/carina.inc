import { z } from "zod";

export const ComplianceFlagSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning", "violation"]),
  detail: z.string(),
});
export type ComplianceFlag = z.infer<typeof ComplianceFlagSchema>;

export const AuditEventViewSchema = z.object({
  id: z.string(),
  clientId: z.string().optional(),
  channel: z.string(),
  query: z.string(),
  agents: z.array(z.string()),
  flags: z.array(ComplianceFlagSchema),
  durationMs: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type AuditEventView = z.infer<typeof AuditEventViewSchema>;
