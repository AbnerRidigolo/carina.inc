import { z } from "zod";

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  traceId: z.string(),
});
export type Problem = z.infer<typeof ProblemSchema>;
