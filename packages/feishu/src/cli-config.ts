import { z } from 'zod';

export const FeishuCliConfigSchema = z.object({
  enabled: z.boolean().optional(),
  autoUpdate: z.boolean().optional(),
  updateCheckIntervalHours: z.number().int().min(1).max(720).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  userAuth: z.boolean().optional(),
}).strict().optional();

export function resolveCliConfig(value?: z.infer<typeof FeishuCliConfigSchema>) {
  return {
    enabled: value?.enabled ?? true,
    autoUpdate: value?.autoUpdate ?? true,
    updateCheckIntervalHours: value?.updateCheckIntervalHours ?? 24,
    version: value?.version,
    userAuth: value?.userAuth ?? false,
  };
}
