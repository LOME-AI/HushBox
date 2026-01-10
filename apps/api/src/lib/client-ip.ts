/**
 * Client IP utilities for rate limiting and guest identification.
 */

import { createHash } from 'crypto';

/**
 * Hash an IP address for privacy.
 * Uses SHA256 to produce a consistent hash that can be stored
 * without exposing the original IP.
 */
export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

export interface RequestContext {
  req: {
    header: (name: string) => string | undefined;
  };
}

/**
 * Get client IP from request headers.
 * Checks common proxy headers in order of preference:
 * 1. x-forwarded-for (takes first IP if multiple)
 * 2. x-real-ip
 * 3. Returns 'unknown' if no headers present
 */
export function getClientIp(c: RequestContext): string {
  // Check common proxy headers
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    // Take the first IP if there are multiple
    const firstIp = forwarded.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = c.req.header('x-real-ip');
  if (realIp) {
    return realIp;
  }

  return 'unknown';
}
