import { describe, expect, it } from 'vitest';

import { accessTeamHost } from './access-host.ts';

describe('accessTeamHost', () => {
  it("names the Access team's own host under the Cloudflare Access domain", () => {
    expect(accessTeamHost('example-team')).toBe('example-team.cloudflareaccess.com');
  });
});
