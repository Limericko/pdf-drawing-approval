import { z } from "zod";

export const uuidV7Schema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
);
export const isoDateTimeSchema = z.string().datetime();
export const optimisticVersionSchema = z.number().int().positive();
export const idempotencyKeySchema = z.string().trim().min(8).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const pageNumberSchema = z.number().int().positive();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
}).strict();

export const pageInfoSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative()
}).strict();

export function boundedText(minimum: number, maximum: number) {
  return z.string().trim().min(minimum).max(maximum).refine((value) => !value.includes("\0"));
}
