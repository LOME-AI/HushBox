import { describe, expect, it } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-time';
import { renderEmail } from '../email/render.js';
import { chargebackLockEmail } from './chargeback-lock.js';

// Byte-level pins on the rendered HTML of the templates below. Each of them
// renders through the shared email renderer, so an edit there reaches every
// template at once; these snapshots are where that lands instead of in a
// delivered email. Re-record only against a source change you can point at.
describe('email template html is byte-stable', () => {
  it('chargeback-lock', () => {
    expect(
      renderEmail(chargebackLockEmail, { userName: 'Sam' }, { sentAt: new Date(TEST_YEAR_START) })
        .html
    ).toMatchSnapshot();
  });
});
