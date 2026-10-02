import { describe, expect, it } from 'vitest';
import { parseLifecycleConfigurationResponse } from './backup-lifecycle-xml.js';

function configuration(...rules: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<LifecycleConfiguration>${rules.join('')}</LifecycleConfiguration>`;
}

const NONCURRENT_RULE = `<Rule>
  <ID>expire-hidden</ID>
  <Filter><Prefix>repository/</Prefix></Filter>
  <Status>Enabled</Status>
  <NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration>
</Rule>`;

describe('parseLifecycleConfigurationResponse', () => {
  it('reads the prefix and the noncurrent expiry off a rule', () => {
    expect(parseLifecycleConfigurationResponse(configuration(NONCURRENT_RULE))).toEqual([
      { prefix: 'repository/', noncurrentDays: 30 },
    ]);
  });

  it('reads an empty configuration as no rules', () => {
    expect(parseLifecycleConfigurationResponse(configuration())).toEqual([]);
  });

  it('reads a rule with no Prefix as covering the whole bucket', () => {
    const bucketWide = `<Rule>
      <ID>everything</ID>
      <Filter></Filter>
      <Status>Enabled</Status>
      <NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration>
    </Rule>`;
    expect(parseLifecycleConfigurationResponse(configuration(bucketWide))).toEqual([
      { prefix: '', noncurrentDays: 30 },
    ]);
  });

  it('returns a rule that expires no noncurrent version without a duration', () => {
    const hideOnly = `<Rule>
      <ID>hide-old</ID>
      <Filter><Prefix>repository/</Prefix></Filter>
      <Status>Enabled</Status>
      <Expiration><Days>7</Days></Expiration>
    </Rule>`;
    expect(parseLifecycleConfigurationResponse(configuration(hideOnly))).toEqual([
      { prefix: 'repository/' },
    ]);
  });

  it('never reads an Expiration Days as the noncurrent expiry', () => {
    // Backblaze B2 returns a hide action as an Expiration rule beside the
    // delete action's own rule, so a parser that took the first <Days>-shaped
    // number in a rule would report the hide delay as the destroy delay.
    const both = `<Rule>
      <ID>hide-then-delete</ID>
      <Filter><Prefix>repository/</Prefix></Filter>
      <Status>Enabled</Status>
      <Expiration><Days>7</Days></Expiration>
      <NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration>
    </Rule>`;
    expect(parseLifecycleConfigurationResponse(configuration(both))).toEqual([
      { prefix: 'repository/', noncurrentDays: 30 },
    ]);
  });

  it('drops a rule the store is not applying', () => {
    const disabled = NONCURRENT_RULE.replace(
      '<Status>Enabled</Status>',
      '<Status>Disabled</Status>'
    );
    expect(parseLifecycleConfigurationResponse(configuration(disabled))).toEqual([]);
  });

  it('reads every rule in a configuration that carries several', () => {
    const second = NONCURRENT_RULE.replace('repository/', 'elsewhere/').replace('30', '7');
    expect(parseLifecycleConfigurationResponse(configuration(NONCURRENT_RULE, second))).toEqual([
      { prefix: 'repository/', noncurrentDays: 30 },
      { prefix: 'elsewhere/', noncurrentDays: 7 },
    ]);
  });

  it('tolerates a namespace prefix on every tag', () => {
    const namespaced = `<s3:Rule>
      <s3:ID>expire-hidden</s3:ID>
      <s3:Filter><s3:Prefix>repository/</s3:Prefix></s3:Filter>
      <s3:Status>Enabled</s3:Status>
      <s3:NoncurrentVersionExpiration><s3:NoncurrentDays>30</s3:NoncurrentDays></s3:NoncurrentVersionExpiration>
    </s3:Rule>`;
    expect(parseLifecycleConfigurationResponse(configuration(namespaced))).toEqual([
      { prefix: 'repository/', noncurrentDays: 30 },
    ]);
  });

  it('throws on a noncurrent expiry that states no day count at all', () => {
    // Distinct from the rule that declares no such action: the action IS
    // declared, so reading it as "expires nothing" would report a bucket whose
    // retention cannot be determined as one with a known, unlimited retention.
    const empty = NONCURRENT_RULE.replace(
      '<NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration>',
      '<NoncurrentVersionExpiration></NoncurrentVersionExpiration>'
    );
    expect(() => parseLifecycleConfigurationResponse(configuration(empty))).toThrow(TypeError);
  });

  it('throws on a non-numeric noncurrent expiry rather than reading it as no expiry', () => {
    const malformed = NONCURRENT_RULE.replace(
      '<NoncurrentDays>30</NoncurrentDays>',
      '<NoncurrentDays>soon</NoncurrentDays>'
    );
    expect(() => parseLifecycleConfigurationResponse(configuration(malformed))).toThrow(TypeError);
  });
});
