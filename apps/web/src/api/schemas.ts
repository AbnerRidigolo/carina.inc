import { z } from "zod";

/** Cliente final do tenant (`GET /api/clients`); o `externalId` é o que as demais rotas usam. */
export const ClientSummarySchema = z.object({
  id: z.uuid(),
  externalId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type ClientSummary = z.infer<typeof ClientSummarySchema>;
export const ClientListSchema = z.array(ClientSummarySchema);
