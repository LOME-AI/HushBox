import { describe, it, expect } from 'vitest';
import {
  APP_RETURN_TO_BILLING_URL,
  APP_URL_SCHEME,
  MANAGE_BALANCE_ONLINE_LABEL,
} from './billing-portal.ts';

describe('the billing portal constants', () => {
  it('names the app URL scheme', () => {
    expect(APP_URL_SCHEME).toBe('hushbox');
  });

  it("parses the return link to the app's own scheme", () => {
    expect(new URL(APP_RETURN_TO_BILLING_URL).protocol).toBe(`${APP_URL_SCHEME}:`);
  });

  it('parses the return link to the billing host', () => {
    expect(new URL(APP_RETURN_TO_BILLING_URL).host).toBe('billing');
  });

  it('carries nothing past the host on the return link', () => {
    const url = new URL(APP_RETURN_TO_BILLING_URL);

    expect(url.pathname + url.search + url.hash).toBe('');
  });

  it('names the button that mints a portal link', () => {
    expect(MANAGE_BALANCE_ONLINE_LABEL).toBe('Manage Balance Online');
  });

  it('publishes the constants on their own package entry', async () => {
    const published = await import('@hushbox/shared/billing-portal');

    expect(published.APP_RETURN_TO_BILLING_URL).toBe(APP_RETURN_TO_BILLING_URL);
  });
});
