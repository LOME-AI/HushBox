/**
 * The header Cloudflare Access forwards its signed identity assertion in. The Worker's
 * admin stage reads it, and the local dev and E2E callers present a minted token under it.
 */
export const CF_ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
