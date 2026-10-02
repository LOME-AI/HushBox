/**
 * The form an address takes as the key of `newsletter_subscribers`, whose
 * uniqueness is (email, topic). It lives here so the single writer of that
 * table states its own key rule, rather than inheriting one from whichever
 * slice supplied the address: an account email arrives from identity, and
 * nothing at that boundary guarantees its case.
 */
export function newsletterEmailKey(email: string): string {
  return email.toLowerCase();
}
