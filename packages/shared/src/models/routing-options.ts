/**
 * OpenRouter routing options, single-sourced per call-family.
 *
 * - Language (`openrouter.chat`) routes under a typed `settings.provider`
 *   carrying `zdr: true` and `data_collection: 'deny'`, which restrict every
 *   endpoint the router tries, fallbacks included, to zero-data-retention
 *   endpoints. It routes cheapest-first (`sort: 'price'`) with fallbacks,
 *   under one `max_price` no serving endpoint may exceed. `transforms: []`
 *   (disable prompt compression) goes in `extraBody`, and `usage: { include:
 *   true }` turns on inline usage/cost accounting.
 * - Image calls go to the Images API, whose `provider` schema has no `zdr` or
 *   `data_collection` field. The request-level ZDR mechanism there is `only`:
 *   the model's pinned ZDR endpoint tags, derived at catalog ingestion from
 *   OpenRouter's ZDR listing, with fallbacks off, through the typed
 *   `settings.provider`.
 * - Video calls carry the language block's ZDR fields in `extraBody.provider`,
 *   but the Videos API's `provider` schema defines none of them, so they
 *   enforce nothing; the catalog exposes a video model only when OpenRouter's
 *   ZDR listing names it.
 *
 * The shape differs by call-family because of a wire footgun: OpenRouter's
 * `extraBody.provider` REPLACES `settings.provider` in the outgoing body (it
 * does not deep-merge), so one call never sets both.
 *
 * These are plain data shapes (no dependency on the provider SDK's types); the
 * adapters spread them into the model settings. A lint guard forbids inlining
 * these literals in adapter code so this stays the one source.
 */

/** A call's price cap on the wire: USD per million tokens, per rate. */
export interface MaxPrice {
  readonly prompt: string;
  readonly completion: string;
}

/** The provider-routing directives the video adapter sends. */
interface MediaProviderRouting {
  readonly zdr: true;
  readonly data_collection: 'deny';
  readonly allow_fallbacks: false;
}

/** The provider-routing directives pinned on every language request. */
export interface OpenRouterProviderRouting {
  readonly zdr: true;
  readonly data_collection: 'deny';
  readonly allow_fallbacks: true;
  /** The router tries the cheapest eligible endpoint first. */
  readonly sort: 'price';
  /** No endpoint priced above either rate can serve the call. */
  readonly max_price: MaxPrice;
  /**
   * Present (and `true`) iff the call carries a `reasoning` config: by
   * default OpenRouter lets an endpoint that doesn't implement a parameter
   * silently IGNORE it, so a reasoning request could bill as a plain turn.
   * Restricting routing to endpoints supporting every sent parameter is the
   * guard; it can surface a "no endpoints found" refusal, which the adapter
   * types distinctly. Never set on reasoning-free calls — it would narrow
   * the endpoint pool for no benefit.
   */
  readonly require_parameters?: true;
}

/** The per-call facts the language routing variant keys on. */
interface LanguageRoutingVariant {
  /** Whether the call carries a `reasoning` config. */
  readonly reasoning: boolean;
  /** The call's price cap, one value for every step of the call. */
  readonly maxPrice: MaxPrice;
}

/** Language-family model settings: typed `provider`, `usage`, and `extraBody`. */
export interface LanguageRoutingOptions {
  readonly provider: OpenRouterProviderRouting;
  readonly usage: { readonly include: true };
  readonly extraBody: { readonly transforms: readonly [] };
}

/** Video-family model settings: the provider block rides in `extraBody`. */
export interface MediaRoutingOptions {
  readonly extraBody: {
    readonly provider: MediaProviderRouting;
    readonly transforms: readonly [];
  };
}

export function languageRoutingOptions(variant: LanguageRoutingVariant): LanguageRoutingOptions {
  return {
    provider: {
      zdr: true,
      data_collection: 'deny',
      allow_fallbacks: true,
      sort: 'price',
      max_price: { prompt: variant.maxPrice.prompt, completion: variant.maxPrice.completion },
      ...(variant.reasoning ? { require_parameters: true } : {}),
    },
    usage: { include: true },
    extraBody: { transforms: [] },
  };
}

/** Image-family model settings: the pinned endpoints in the typed `provider`. */
export interface ImageRoutingOptions {
  readonly provider: {
    /** Fresh and mutable, because the SDK types `only` as `string[]`. */
    readonly only: string[];
    readonly allow_fallbacks: false;
  };
}

/**
 * Restricts an image call to the model's pinned ZDR endpoint tags. A pin with no
 * tag names no endpoint the call may reach, so it is refused before any request
 * is built.
 */
export function imageRoutingOptions(pin: readonly [string, ...string[]]): ImageRoutingOptions {
  if (pin.length === 0) {
    throw new Error('image routing has no ZDR endpoint tag to pin');
  }
  return { provider: { only: [...pin], allow_fallbacks: false } };
}

export function mediaRoutingOptions(): MediaRoutingOptions {
  return {
    extraBody: {
      provider: { zdr: true, data_collection: 'deny', allow_fallbacks: false },
      transforms: [],
    },
  };
}
