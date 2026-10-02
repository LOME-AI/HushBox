import { z } from 'zod';

/** The dev-only admin-token mint's answer: an Access assertion and the header to present it under. */
export const devAdminTokenResponseSchema = z.object({
  token: z.string(),
  header: z.string(),
});

export type DevAdminTokenResponse = z.infer<typeof devAdminTokenResponseSchema>;
