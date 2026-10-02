/**
 * The teardown gate on the exact-money rule: a test that read money from the
 * running system and asserted nothing exact about it fails at teardown.
 *
 * Both halves of that sentence are facts the vocabulary already produces, and
 * that is the whole design. "Touched money" is a read — every fetch door in
 * `e2e/helpers/exact-money.ts` announces itself here on the line that performs
 * it. "Asserted exactly" is a comparison — every comparator in `money.ts`
 * announces itself here on the line that compares. Neither half is a list of
 * specs, of routes, or of surfaces that someone has to keep current: adding a
 * read or a comparator extends the gate, and a list nobody maintains is exactly
 * what a maintained list of money-touching specs would have decayed into.
 *
 * **What "touched money" means here, precisely, and what it does not.** It means
 * the vocabulary observed the running system's money for this test. A test that
 * moves money and never asks what happened registers nothing — the gate cannot
 * see a touch nobody made, and no runtime fact distinguishes such a test from
 * one that only rendered a page. That is a limit of reach, recorded rather than
 * papered over: this gate catches the half-converted spec, the deleted
 * assertion, and the read left behind by one — not the spec that never looked.
 *
 * A DERIVATION is not itself a touch — no minter announces here — and that is
 * narrower than "deriving keeps a spec outside the gate". What decides is where
 * the derivation's input came from: a minter that prices from a SERVED payload
 * takes that payload from a read, and the read announced on the line that
 * fetched it, so such a test is already inside the gate before its minter runs.
 * Only a minter over a constant or a count leaves no trace, and that is the case
 * this paragraph is about — a spec legitimately mints an expected amount from an
 * imported constant to compare against something the vocabulary does not read, a
 * rendered figure it asserts exactly. Counting the minter itself would also
 * misattribute: a derivation at module scope runs at import, and belongs to no
 * test.
 *
 * **A second limit, on the other half: the verdict is a FLOOR, not a pairing
 * check.** One comparison satisfies any number of reads, so a spec that reads
 * two things and asserts one of them passes here. What this proves is that a
 * money-touching test made at least one exact assertion — never that it asserted
 * on everything it observed. Add a second read to a spec and nothing here will
 * ask for its assertion; that one is on review.
 *
 * **The way past the gate is not an opt-out.** `budget.ts`'s `setWalletBalance`
 * and `getFundingSnapshot` are the unbranded precondition path the vocabulary
 * already documents, and they announce nothing here. Taking them costs the
 * spec its derivation source: their values carry no brand, so no minter and no
 * comparator accepts one. The escape is "assert nothing about money", never
 * "keep asserting loosely and skip the gate", and there is no tag, no
 * allowlist and no per-spec exemption.
 *
 * **What is known and not refused.** {@link noteMoneyComparison} is exported
 * because the comparators live in a module of their own, so a spec that
 * imported this module directly could record an assertion it never made. It is
 * one greppable line, in the same class as the casts `money.ts` leaves
 * deliberately open, and nothing else reaches it: specs import the vocabulary
 * through `e2e/helpers/exact-money.ts`, which does not re-export it.
 * {@link noteMoneyRead} is open for the same reason and costs nothing — a
 * forged read only makes the gate stricter about the test that forged it.
 *
 * The ledger is module state, which the suite's worker model makes per-test:
 * a worker runs its tests one at a time, the fixture clears the ledger before
 * each and drains it after. It lives beside `money.ts` rather than inside
 * it because it is not vocabulary — nothing here brands, prices or compares —
 * and because `@hushbox/e2e` has no unit-test runner, while every decision this
 * module makes is pinned by real tests here. The doors are pinned here too, in
 * `money-doors.test.ts`: a canned request context reaches them without
 * Playwright, so deleting one of their announcements reddens a test rather than
 * silently switching the gate off for the reads behind it.
 */

const reads: string[] = [];
const comparisons: string[] = [];

/** What one test read from the running system, and what it compared. */
interface MoneyLedger {
  /** The reads that fetched money, first occurrence order, each named once. */
  readonly reads: readonly string[];
  /** The comparators that ran, on the same terms. */
  readonly comparisons: readonly string[];
}

function record(into: string[], what: string): void {
  if (!into.includes(what)) into.push(what);
}

/**
 * A fetch door in `e2e/helpers/exact-money.ts` reporting that it just brought
 * money back off the wire. Called on the line that fetches, so a read added
 * there is covered by the door it goes through rather than by remembering this.
 *
 * The wallet seed is one of those doors even though it WRITES: what it reports
 * here is the balance the route said it applied, which is a value the spec then
 * prices its expectation from.
 */
export function noteMoneyRead(what: string): void {
  record(reads, what);
}

/**
 * A comparator in `money.ts` reporting that it ran. Recorded whatever the
 * verdict: a comparison that DIVERGED is still an assertion the test made, and
 * it fails the test on its own terms rather than through this gate.
 */
export function noteMoneyComparison(what: string): void {
  record(comparisons, what);
}

/** Clear the ledger — the fixture's setup, before a test can touch anything. */
export function resetMoneyLedger(): void {
  reads.length = 0;
  comparisons.length = 0;
}

/** The finished test's ledger, drained so the next test starts from nothing. */
export function takeMoneyLedger(): MoneyLedger {
  const taken: MoneyLedger = { reads: [...reads], comparisons: [...comparisons] };
  resetMoneyLedger();
  return taken;
}

/** The finished test, as the gate needs to name and judge it. */
interface GatedSpec {
  readonly title: string;
  readonly file: string;
  /** Whether the test already failed. A failed test is never gated further. */
  readonly failed: boolean;
}

/**
 * The failure message for a test that read money and compared none, or `null`
 * when there is nothing to say.
 *
 * A test that already failed is passed over: the gate would add a second error
 * beside the real one, and a money assertion missing from a test that never got
 * that far is a conclusion this cannot draw.
 */
export function moneyGateFailure(ledger: MoneyLedger, spec: GatedSpec): string | null {
  if (spec.failed) return null;
  if (ledger.reads.length === 0) return null;
  if (ledger.comparisons.length > 0) return null;
  return (
    `The exact-money gate failed "${spec.title}" (${spec.file}).\n\n` +
    'This test observed money from the running system and asserted nothing exact about it.\n' +
    `  money observed: ${ledger.reads.join(', ')}\n` +
    '  exact-money assertions: none\n\n' +
    'A test that observes money compares it, through the `expect…` assertions in ' +
    'e2e/helpers/exact-money.ts — including the ones for a run that legitimately bills ' +
    'nothing.\n\n' +
    'If the value is only a precondition the test asserts nothing about, take the unbranded ' +
    'path instead: setWalletBalance and getFundingSnapshot in e2e/helpers/budget.ts. That is ' +
    'the only way past this gate, and it is not an opt-out — their values carry no brand, so ' +
    'no derivation and no comparison can be built on them.'
  );
}
