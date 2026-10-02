import { AuditAddressProvider } from '@/api/audit-address';
import type { JSX, ReactNode } from 'react';

/** The audit a console test addresses: any name the server's allowlist admits. */
export const TEST_AUDIT = '2026-07-30';

/**
 * Mounts a subtree the way the shell does, with an audit for its requests to
 * address. A console surface that writes, briefs or peeks has no meaning
 * without one, so a test of such a surface renders it through here.
 */
export function withAuditAddress({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return <AuditAddressProvider audit={TEST_AUDIT}>{children}</AuditAddressProvider>;
}
