import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { BRAVE_SEARCH_API_KEY_PLACEHOLDER } from '@hushbox/shared';
import { createBraveSearchProvider } from './brave-search.js';
import { createFakeSearchProvider } from './fake-search-provider.js';
import { CASSETTE_ROOT } from './resolve-model-provider.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { cassetteModeFor } from './cassette/mode.js';
import type { BraveSearchProviderOptions } from './brave-search.js';
import type { CassetteStore } from './cassette/cassette-store.js';
import type { Database } from '@hushbox/db';
import type { WebSearchResults } from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { SearchProvider } from '../ports/index.js';

/**
 * The one place web search's backend is chosen, gated as `resolveModelProvider`
 * gates inference. The two agree on which world a run is in only while the
 * composition root hands both the same `useMock` and `isCI`:
 *
 *   1. the model provider is the mock  → the fake. No network, no key, no evidence.
 *   2. real + CI-vitest                → Brave over the record-on-miss cassette,
 *      writing `brave-search` service evidence after each successful search.
 *   3. real + production               → Brave over plain `fetch`.
 */

interface ResolveSearchProviderInput {
  /** True exactly when this run's model provider resolves to the mock. */
  readonly useMock: boolean;
  /** `BRAVE_SEARCH_API_KEY`; must be non-empty on either real path. */
  readonly apiKey: string;
  /** CI classification: selects the cassette and the evidence write. */
  readonly isCI: boolean;
  /** Where the CI path writes its evidence row; unused on the others. */
  readonly db: Database | undefined;
  /** Where the Brave adapter captures the failures an operator must act on. */
  readonly telemetry: Telemetry;
}

/** Test seams: the Brave factory, the cassette store, and the transport the cassette records from. */
interface ResolveSearchProviderInternals {
  readonly createBrave?: (options: BraveSearchProviderOptions) => SearchProvider;
  readonly store?: CassetteStore;
  readonly realFetch?: typeof globalThis.fetch;
}

/** Records `brave-search` evidence after each search that resolved, whether live or replayed. */
function withEvidenceOnSuccess(
  provider: SearchProvider,
  db: Database,
  isCI: boolean
): SearchProvider {
  return {
    async search(query, options): Promise<WebSearchResults> {
      const results = await provider.search(query, options);
      await recordServiceEvidence(db, isCI, SERVICE_NAMES.BRAVE_SEARCH);
      return results;
    },
  };
}

export function resolveSearchProvider(
  input: ResolveSearchProviderInput,
  internals: ResolveSearchProviderInternals = {}
): SearchProvider {
  if (input.useMock) return createFakeSearchProvider();

  if (input.apiKey === '') {
    throw new Error(
      'resolveSearchProvider: real web search requires a non-empty BRAVE_SEARCH_API_KEY; the runtime fails fast instead of degrading.'
    );
  }

  const createBrave = internals.createBrave ?? createBraveSearchProvider;
  if (!input.isCI) {
    return createBrave({ apiKey: input.apiKey, telemetry: input.telemetry });
  }

  // A CI recording made with the local placeholder would be a refused call rather than a search.
  if (input.apiKey === BRAVE_SEARCH_API_KEY_PLACEHOLDER) {
    throw new Error(
      'resolveSearchProvider: refusing to record CI cassettes against the local placeholder BRAVE_SEARCH_API_KEY.'
    );
  }
  if (input.db === undefined) {
    throw new Error(
      'resolveSearchProvider: the CI-vitest path requires a db for service evidence.'
    );
  }

  const fetch = createCassetteFetch({
    store: internals.store ?? createCassetteStore({ rootDir: CASSETTE_ROOT }),
    mode: cassetteModeFor(),
    realFetch: internals.realFetch ?? globalThis.fetch.bind(globalThis),
  });
  const provider = createBrave({ apiKey: input.apiKey, telemetry: input.telemetry, fetch });
  return withEvidenceOnSuccess(provider, input.db, input.isCI);
}
