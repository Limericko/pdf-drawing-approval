import { z } from "zod";

export const problemDetailsSchema = z.object({
  type: z.literal("about:blank"),
  title: z.string().min(1).max(120),
  status: z.number().int().min(400).max(599),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
  requestId: z.string().min(1).max(128)
}).strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
