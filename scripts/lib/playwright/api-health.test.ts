import { describe, it, expect } from 'vitest';

import { apiHealthUrl } from './api-health.js';

describe('apiHealthUrl', () => {
  it('addresses the local API worker on the port it is given', () => {
    expect(apiHealthUrl('59993')).toBe('http://localhost:59993/health');
  });
});
