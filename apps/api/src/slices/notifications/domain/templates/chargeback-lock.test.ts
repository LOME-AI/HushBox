import { describe, it, expect } from 'vitest';
import { chargebackLockEmail } from './chargeback-lock.js';

describe('chargebackLockEmail', () => {
  it('states the account is locked', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('Account Locked');
  });

  it('references the payment dispute in both bodies', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('dispute');
    expect(result.text).toContain('dispute');
  });

  it('names the legal contact address in the html body', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('legal@hushbox.ai');
  });

  it('names the legal contact address in the text body', () => {
    const result = chargebackLockEmail({});

    expect(result.text).toContain('legal@hushbox.ai');
  });

  it('names no billing address in either body', () => {
    const result = chargebackLockEmail({});

    expect(result.html).not.toContain('billing@hushbox.ai');
    expect(result.text).not.toContain('billing@hushbox.ai');
  });

  it('keeps the general questions address in the text footer', () => {
    const result = chargebackLockEmail({});

    expect(result.text).toContain('Questions? hello@hushbox.ai');
  });

  it('carries no lockout-duration copy', () => {
    const result = chargebackLockEmail({});

    expect(result.text).not.toContain('minutes');
    expect(result.html).not.toContain('minutes');
  });

  it('greets the user by name when provided', () => {
    const result = chargebackLockEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });
});
