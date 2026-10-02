import { ROUTES, type MessageSegment } from '@hushbox/shared';
import { turnNoticeForCode, type TurnNotice } from '@/lib/chat/turn-notice';

/** A trial stream refusal resolved to its notice and composer policy. */
interface TrialRefusal {
  notice: TurnNotice;
  /**
   * True when nothing the user can do this session will succeed (personal
   * daily quota spent, or the global trial pool is exhausted for the day).
   */
  disablesComposer: boolean;
}

const SIGN_UP_LINK: MessageSegment = { text: 'Sign up free', link: ROUTES.SIGNUP };

function extractCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}

function extractDetails(error: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof error !== 'object' || error === null || !('details' in error)) return undefined;
  const { details } = error as { details: unknown };
  return typeof details === 'object' && details !== null
    ? (details as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * The code's own notice with a link after its action. A refusal that leaves
 * the user nothing to do on this page withholds Regenerate, since no re-run
 * can succeed.
 */
function refusal(
  noticeCode: string,
  link: MessageSegment,
  disablesComposer: boolean,
  details?: Readonly<Record<string, unknown>>
): TrialRefusal {
  const notice = turnNoticeForCode(noticeCode, details);
  const action = notice.action.length === 0 ? [link] : [...notice.action, { text: ' ' }, link];
  return {
    notice: { ...notice, action, regenerate: disablesComposer ? 'withheld' : 'offered' },
    disablesComposer,
  };
}

type RefusalBuilder = (error: unknown) => TrialRefusal;

/** The session is done for the day: nothing the user retries will succeed. */
const personalQuotaSpent: RefusalBuilder = () => refusal('TRIAL_LIMIT_REACHED', SIGN_UP_LINK, true);

function signupNudge(code: string): RefusalBuilder {
  return () => refusal(code, SIGN_UP_LINK, false);
}

// A Map, not a plain object: the code string comes off the wire, and a plain
// object lookup would resolve prototype keys ('constructor') to functions.
const REFUSAL_BUILDERS = new Map<string, RefusalBuilder>([
  ['TRIAL_LIMIT_REACHED', personalQuotaSpent],
  // DAILY_LIMIT_EXCEEDED is the current wire's name for the same personal
  // daily-quota refusal; both source the one shared trial-limit message.
  ['DAILY_LIMIT_EXCEEDED', personalQuotaSpent],
  ['TRIAL_CAPACITY_REACHED', () => refusal('TRIAL_CAPACITY_REACHED', SIGN_UP_LINK, true)],
  // An authenticated user has no business composing on the trial page (the
  // page already redirects them; this is the belt-and-braces path), and they
  // already have an account — link them into the app, not to sign-up.
  [
    'AUTHENTICATED_ON_TRIAL',
    () => refusal('AUTHENTICATED_ON_TRIAL', { text: 'Go to your chats', link: ROUTES.CHAT }, true),
  ],
  ['TRIAL_MESSAGE_TOO_EXPENSIVE', signupNudge('TRIAL_MESSAGE_TOO_EXPENSIVE')],
  ['PREMIUM_REQUIRES_ACCOUNT', signupNudge('PREMIUM_REQUIRES_ACCOUNT')],
  ['MEDIA_TRIAL_BLOCKED', signupNudge('MEDIA_TRIAL_BLOCKED')],
  ['FEATURE_REQUIRES_AUTH', signupNudge('FEATURE_REQUIRES_AUTH')],
  ['RATE_LIMITED', (error) => refusal('RATE_LIMITED', SIGN_UP_LINK, false, extractDetails(error))],
]);

/**
 * Maps a trial stream error to its notice, keyed on the wire code carried by
 * the thrown error. Both wire vocabularies for the trial refusals — the
 * endpoint's current code names and the shared ERROR_CODES names — resolve
 * here, so the mapping is independent of which API serves the stream. Returns
 * null for anything that is not a known refusal (callers fall back to the
 * generic error path).
 */
export function trialRefusalFor(error: unknown): TrialRefusal | null {
  const code = extractCode(error);
  if (code === undefined) return null;
  const build = REFUSAL_BUILDERS.get(code);
  return build === undefined ? null : build(error);
}
