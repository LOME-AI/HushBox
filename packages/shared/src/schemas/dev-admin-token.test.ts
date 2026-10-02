import { describe, expect, it } from 'vitest';
import { CF_ACCESS_JWT_HEADER } from './cf-access-jwt-header.ts';
import { devAdminTokenResponseSchema } from './dev-admin-token.ts';

describe('devAdminTokenResponseSchema', () => {
  const minted = { token: 'header.payload.signature', header: CF_ACCESS_JWT_HEADER };

  it('accepts a token with the header to present it under', () => {
    expect(devAdminTokenResponseSchema.parse(minted)).toEqual(minted);
  });

  it('rejects a response without the token', () => {
    expect(devAdminTokenResponseSchema.safeParse({ header: minted.header }).success).toBe(false);
  });

  it('rejects a response without the header', () => {
    expect(devAdminTokenResponseSchema.safeParse({ token: minted.token }).success).toBe(false);
  });
});
