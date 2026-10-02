import { z } from 'zod';

/**
 * App-wide announcement banner contracts, shared by the API, the React app, and
 * the Astro marketing site.
 *
 * `banner_config` has a single writer — the announcements slice, via its
 * published write path composed by the admin `banner.set` operation — but the
 * jsonb stays untrusted at read time (legacy hand-edited rows and any
 * historical data predate that path): `bannerConfigSchema` salvages what it
 * can (drops invalid messages,
 * strips unsafe links, falls each message's unknown variant back to `info`) and
 * degrades a broken row to disabled rather than throwing. The hash that keys dismissal is computed
 * server-side over the normalized content and is opaque to clients, so the wire
 * contract (`bannerResponseSchema`) carries clean data only.
 */

export const BANNER_VARIANTS = ['info', 'warning', 'critical'] as const;
export const MAX_BANNER_MESSAGES = 20;
export const MAX_BANNER_TEXT_LENGTH = 280;
export const MAX_BANNER_LINK_TEXT_LENGTH = 60;

export const bannerVariantSchema = z.enum(BANNER_VARIANTS);
export type BannerVariant = z.infer<typeof bannerVariantSchema>;

export interface BannerMessage {
  id?: string;
  text: string;
  variant: BannerVariant;
  href?: string;
  linkText?: string;
}

function isBannerVariant(value: unknown): value is BannerVariant {
  return typeof value === 'string' && (BANNER_VARIANTS as readonly string[]).includes(value);
}

/**
 * Two bases, and they must name different origins. A path carrying no authority of
 * its own resolves to whichever base it is given, so it matches both; a value the
 * parser folds into an authority resolves to that host whatever the base, so it can
 * match at most one and is refused. Against a single base the one literal that
 * launders is the base's own host, which the comparison then reads as same-origin.
 * `.invalid` is reserved by RFC 2606, so neither base can collide with a real
 * deployment origin — which matters because the app, the marketing site and the API
 * each render banners from a different one.
 */
const SAME_SITE_BASES = ['https://relative.invalid', 'https://alternate.invalid'] as const;

/**
 * A link target is safe as an http(s) absolute URL, or as a path the WHATWG URL
 * parser resolves back to the origin it was resolved against. Resolving is what
 * makes the second half a boundary rather than a test on the leading characters:
 * the parser folds `//host`, `/\host`, percent-encoded and tab- or newline-split
 * forms into an authority, and a value carrying an authority resolves to that host
 * whatever the base, so no spelling of one survives both bases. `javascript:` and
 * `data:` fail the scheme check, so an operator typo can never become a
 * script-injection or open-redirect vector.
 */
function isSafeHref(value: string): boolean {
  if (value.startsWith('/')) {
    try {
      return SAME_SITE_BASES.every((base) => new URL(value, base).origin === base);
    } catch {
      return false;
    }
  }
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Trim, then enforce a non-empty bounded length, so whitespace-only copy is rejected. */
const boundedText = (max: number): z.ZodType<string> =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max));

/**
 * `text` is validated (a message with no usable text is dropped at the set level);
 * `variant`/`href`/`linkText` are lenient — an unknown variant salvages to `info`
 * and an unsafe or malformed link is stripped to keep the message rather than
 * discarding the announcement.
 */
export const bannerMessageSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: boundedText(MAX_BANNER_TEXT_LENGTH),
    variant: z.unknown().optional(),
    href: z.unknown().optional(),
    linkText: z.unknown().optional(),
  })
  .transform((raw): BannerMessage => {
    const message: BannerMessage = {
      text: raw.text,
      variant: isBannerVariant(raw.variant) ? raw.variant : 'info',
    };
    if (raw.id !== undefined) message.id = raw.id;
    if (typeof raw.href === 'string' && isSafeHref(raw.href)) message.href = raw.href;
    const linkText = typeof raw.linkText === 'string' ? raw.linkText.trim() : '';
    if (linkText.length > 0 && linkText.length <= MAX_BANNER_LINK_TEXT_LENGTH) {
      message.linkText = linkText;
    }
    return message;
  });

/** Clean wire contract the client re-parses; `hash` is null when the banner is disabled. */
export const bannerResponseSchema = z.object({
  hash: z.string().nullable(),
  messages: z.array(bannerMessageSchema).max(MAX_BANNER_MESSAGES),
});
export type BannerResponse = z.infer<typeof bannerResponseSchema>;

interface SalvagedMessages {
  readonly messages: BannerMessage[];
  /**
   * Entries the per-message schema rejected. Deliberately not a length delta:
   * messages beyond `MAX_BANNER_MESSAGES` are truncated, not corrupt, and
   * counting them would make the endpoint's warning fire on a valid row.
   */
  readonly invalidCount: number;
}

function salvageMessages(raw: unknown): SalvagedMessages {
  const items = Array.isArray(raw) ? raw : [];
  const parsed = items.map((item) => bannerMessageSchema.safeParse(item));
  return {
    messages: parsed
      .flatMap((result) => (result.success ? [result.data] : []))
      .slice(0, MAX_BANNER_MESSAGES),
    invalidCount: parsed.filter((result) => !result.success).length,
  };
}

const bannerConfigObjectSchema = z
  .object({
    enabled: z
      .unknown()
      .optional()
      .transform((value) => value === true),
    messages: z.unknown().optional().transform(salvageMessages),
  })
  .transform(({ enabled, messages: salvaged }) => ({
    enabled,
    messages: salvaged.messages,
    droppedCount: salvaged.invalidCount,
  }));

/**
 * Salvaging parse of the operator-edited `banner_config` row. Never throws:
 * `z.unknown()` makes the top level total, a non-object row degrades to disabled,
 * an unknown per-message variant becomes `info`, a non-boolean `enabled` becomes
 * `false`, and invalid messages are dropped. `droppedCount` counts only those
 * invalid entries — never the ones truncated at `MAX_BANNER_MESSAGES` — and the
 * endpoint logs a counts-only warning when it is positive.
 */
export const bannerConfigSchema = z
  .unknown()
  .transform((raw) =>
    bannerConfigObjectSchema.parse(typeof raw === 'object' && raw !== null ? raw : {})
  );
export type BannerConfig = z.infer<typeof bannerConfigSchema>;
