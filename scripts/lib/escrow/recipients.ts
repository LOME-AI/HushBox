/**
 * Who can open an escrow object, and the encrypter that writes to all of them.
 *
 * Write-only storage exists in exactly one construction: encrypt at the writer
 * to keys that exist only offline. The bucket then needs immutability alone, and
 * the credential that writes it leaks nothing readable.
 *
 * Two recipients because the risk bought down is loss, not leak: either private
 * key opens the file and the two are held in two physical places, so a leaked one
 * costs a re-seal where a lost one costs the company. They are committed rather
 * than held as workflow secrets because a public key is not confidential and a
 * diff is the reviewed channel — an edit to a GitHub secret is invisible.
 *
 * No identity is ever generated or read here.
 */
import { Encrypter } from 'age-encryption';

/** The X25519 public recipients supplied by the holder of the two identities. */
/* eslint-disable no-secrets/no-secrets -- age public recipients: high entropy by construction, and publishable by design */
export const ESCROW_RECIPIENTS: readonly string[] = [
  'age1fzqxum32wtrm0rn0fggck7usudquseppnxgh6x2073vr943wnqdsu48uzr',
  'age18au7e8j75x0xdaegy06h2rddfslvt5tv8lz46cqgzev44cdmaeuq0hy59q',
];
/* eslint-enable no-secrets/no-secrets */

/**
 * An encrypter holding every recipient, validated here so a malformed one
 * refuses the run before a secret has been read.
 *
 * The refusal names a position and never the value, and drops the library's own
 * error rather than attaching it as a cause: for an `age1…` value whose bech32
 * checksum is wrong that message quotes the whole input back, and the CLI
 * runner's `messageChain` (`scripts/lib/cli/run-main.ts`) prints every cause to
 * stderr, so attaching it would contradict the withholding the refusal states.
 * The committed array plus the position identifies the bad entry without the
 * library's message.
 */
export function createEscrowEncrypter(recipients: readonly string[]): Encrypter {
  if (recipients.length === 0) {
    throw new Error('escrow: no recipients are configured, so nothing could ever open the file');
  }

  const encrypter = new Encrypter();
  for (const [index, recipient] of recipients.entries()) {
    try {
      encrypter.addRecipient(recipient);
    } catch {
      throw new Error(
        `escrow: recipient ${String(index + 1)} of ${String(recipients.length)} is not a valid ` +
          `age recipient (its value is withheld deliberately)`
      );
    }
  }
  return encrypter;
}
