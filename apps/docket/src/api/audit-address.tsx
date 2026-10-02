import { createContext, useContext } from 'react';
import type { JSX, ReactNode } from 'react';

/**
 * The audit every addressed request names. `null` is no provider above the
 * consumer rather than a console with no audit: the shell resolves a name
 * before it renders anything that could write.
 */
const AuditAddressContext = createContext<string | null>(null);

export function AuditAddressProvider({
  audit,
  children,
}: Readonly<{ audit: string; children: ReactNode }>): JSX.Element {
  return <AuditAddressContext.Provider value={audit}>{children}</AuditAddressContext.Provider>;
}

/**
 * Where a call site learns which audit it is addressing. The value is derived
 * from what the shell already holds — the audit in the url, or the one the
 * server served when the url named none — so no caller has to know which of
 * the two it got, and none of them can be reached without one.
 */
export function useAuditAddress(): string {
  const audit = useContext(AuditAddressContext);
  if (audit === null) {
    throw new Error('the console has no audit to address this request to');
  }
  return audit;
}
