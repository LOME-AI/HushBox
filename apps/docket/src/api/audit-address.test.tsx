import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuditAddressProvider, useAuditAddress } from './audit-address';
import type { JSX } from 'react';

function Address(): JSX.Element {
  return <span>{useAuditAddress()}</span>;
}

describe('useAuditAddress', () => {
  it('hands a consumer the audit the provider names', () => {
    render(
      <AuditAddressProvider audit="2026-07-30">
        <Address />
      </AuditAddressProvider>
    );

    expect(screen.getByText('2026-07-30')).toBeInTheDocument();
  });

  it('hands consumers the audit a switch moved the console to', () => {
    const { rerender } = render(
      <AuditAddressProvider audit="2026-07-30">
        <Address />
      </AuditAddressProvider>
    );

    rerender(
      <AuditAddressProvider audit="2026-08-01">
        <Address />
      </AuditAddressProvider>
    );

    expect(screen.getByText('2026-08-01')).toBeInTheDocument();
  });

  /**
   * A consumer with no provider has no audit to address, and every route that
   * takes one refuses a request that names none. Failing at the mount says so
   * where it can be fixed, rather than at a write the reader has just made.
   */
  it('refuses to render a consumer that has no provider above it', () => {
    expect(() => render(<Address />)).toThrow(/audit/i);
  });
});
