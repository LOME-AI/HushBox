import { extractBlocks, extractTag } from './s3-xml.js';
import type { BackupLifecycleRule } from '../ports/index.js';

/**
 * Hand-rolled reader for an S3 `GetBucketLifecycleConfiguration` response,
 * reduced to the two fields the backup audit judges on.
 *
 * Only `Enabled` rules are returned: a rule the store is not applying destroys
 * nothing, so counting one would let a disabled rule stand in for the retention
 * the published ceiling rests on. A rule declaring no `NoncurrentVersionExpiration`
 * is returned without a duration rather than dropped, because "no rule covers
 * the repository" and "a covering rule expires nothing" are different findings
 * and the judgement can only tell them apart from the rules it is given.
 *
 * The noncurrent expiry is read from inside its own action element rather than
 * from the rule: Backblaze B2 returns one hide action as an `Expiration` rule
 * carrying `Days`, so a reader taking the first day count in a rule would report
 * the hide delay as the destroy delay. A malformed count throws, because
 * reporting it as a rule that expires nothing would name the wrong repair.
 */
export function parseLifecycleConfigurationResponse(xml: string): BackupLifecycleRule[] {
  const rules: BackupLifecycleRule[] = [];
  for (const block of extractBlocks(xml, 'Rule')) {
    if (extractTag(block, 'Status') !== 'Enabled') continue;
    // An absent filter is the bucket-wide one, which is the empty prefix.
    const prefix = extractTag(block, 'Prefix') ?? '';
    const expiration = extractBlocks(block, 'NoncurrentVersionExpiration')[0];
    if (expiration === undefined) {
      rules.push({ prefix });
      continue;
    }
    const days = Number.parseInt(extractTag(expiration, 'NoncurrentDays') ?? '', 10);
    if (!Number.isFinite(days)) {
      throw new TypeError('lifecycle configuration has a non-numeric NoncurrentDays');
    }
    rules.push({ prefix, noncurrentDays: days });
  }
  return rules;
}
