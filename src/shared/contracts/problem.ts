import { z } from "zod";

export const requestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

export const problemDetailsSchema = z.object({
  type: z.literal("about:blank"),
  title: z.string().min(1).max(120),
  status: z.number().int().min(400).max(599),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/),
  requestId: requestIdSchema
}).strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
