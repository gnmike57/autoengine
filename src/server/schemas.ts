import { z } from "zod";

export const WsMessageSchema = z.object({
  type: z.string(),
  data: z.any().optional(),
  config: z.any().optional()
});

export const SetConcurrencySchema = z.object({
  value: z.number().int().min(1).max(500)
});

export const SetBackendSchema = z.object({
  value: z.string()
});
