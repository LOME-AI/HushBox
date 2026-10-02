/**
 * The shared broadcast-time revalidation core: a keyed in-memory memo over a
 * cache→source probe with a bounded last-known-good fail-closed window. Both
 * the membership verifier (revocation.ts) and the session-liveness verifier
 * (session-liveness.ts) are thin adapters over this one implementation, so the
 * memo/fallback discipline that keeps plaintext from a revoked target lives in
 * exactly one place.
 *
 * Three windows, sized by the caller:
 * - `freshnessMs` — the in-memory reuse window: a hot token stream re-probes at
 *   most once per window per key instead of once per frame, so a broadcast is
 *   never an unbounded backend read per token per socket.
 * - `staleAfterMs` — the stale-serve window: between `freshnessMs` and this, a
 *   decision is served from the memo immediately while the probe refreshes
 *   behind it, so a slow backend costs staleness rather than delivery latency.
 *   Past it the probe is awaited, which is what bounds how long a revoked
 *   target can keep receiving. Equal to `freshnessMs` means no stale serving.
 * - `lastKnownGoodMs` — the fail-closed window: when the probe throws (backend
 *   unreachable) a target verified within the window keeps receiving; beyond it
 *   delivery PAUSES rather than risk plaintext to a possibly-revoked target. A
 *   'dead' decision never un-revokes on failure regardless of the window.
 *
 * All three are measured from the last VERIFIED decision, never from the last
 * decision served, so serving a stale answer cannot widen the fail-closed
 * window.
 */

export type LivenessOutcome = 'live' | 'dead';

/** 'pause' = the target's state is unknown right now; skip delivery, keep the socket. */
export type LivenessDecision = LivenessOutcome | 'pause';

/**
 * The per-key cache→source probe. `readCache`/`readSource` REJECT when their
 * backend is unreachable (the fail-closed fallback depends on it); `writeCache`
 * is best-effort and its rejection is swallowed.
 */
export interface LivenessProbe {
  /** Resolves the cached outcome or null on a miss; rejects when the cache is unreachable. */
  readCache(): Promise<LivenessOutcome | null>;
  /** Authoritative recheck on a miss; rejects when the source is unreachable. */
  readSource(): Promise<LivenessOutcome>;
  /** Write-back of a source recheck; best-effort. */
  writeCache(outcome: LivenessOutcome): Promise<void>;
}

interface CachedLivenessOptions {
  readonly freshnessMs: number;
  readonly staleAfterMs: number;
  readonly lastKnownGoodMs: number;
  readonly now: () => number;
}

interface CachedLiveness {
  decide(key: string, probe: LivenessProbe): Promise<LivenessDecision>;
  /** Memoized decisions currently held — the boundedness the sweep maintains. */
  size(): number;
}

interface Decision {
  outcome: LivenessOutcome;
  verifiedAt: number;
}

export function createCachedLiveness(options: CachedLivenessOptions): CachedLiveness {
  const { freshnessMs, staleAfterMs, lastKnownGoodMs, now } = options;
  const memo = new Map<string, Decision>();
  const inFlight = new Map<string, Promise<LivenessDecision>>();

  function fallback(previous: Decision | undefined): LivenessDecision {
    if (previous?.outcome === 'dead') {
      return 'dead';
    }
    if (previous !== undefined && now() - previous.verifiedAt < lastKnownGoodMs) {
      return 'live';
    }
    return 'pause';
  }

  /**
   * Past `lastKnownGoodMs` an entry can no longer answer anything `fallback`
   * would not answer from a fresh probe, so dropping it costs nothing and
   * bounds the memo to the keys seen inside that window. A 'dead' entry is
   * dropped on the same predicate and never earlier: inside the window it is
   * the sticky refusal a failed probe falls back to, and once outside it the
   * source re-answers, with a failed probe pausing rather than delivering.
   */
  function sweep(): void {
    const cutoff = now() - lastKnownGoodMs;
    for (const [key, decision] of memo) {
      if (decision.verifiedAt <= cutoff) {
        memo.delete(key);
      }
    }
  }

  async function runProbe(key: string, probe: LivenessProbe): Promise<LivenessDecision> {
    const previous = memo.get(key);

    let outcome: LivenessOutcome | null;
    try {
      outcome = await probe.readCache();
    } catch {
      return fallback(previous);
    }

    if (outcome === null) {
      try {
        outcome = await probe.readSource();
      } catch {
        return fallback(previous);
      }
      try {
        await probe.writeCache(outcome);
      } catch {
        // Write-back is best-effort: the decision below is already
        // authoritative; the next stale probe simply re-misses.
      }
    }

    sweep();
    memo.set(key, { outcome, verifiedAt: now() });
    return outcome;
  }

  /** Collapses concurrent probes of one key onto one backend read. */
  function probeOnce(key: string, probe: LivenessProbe): Promise<LivenessDecision> {
    const running = inFlight.get(key);
    if (running !== undefined) {
      return running;
    }
    const started = (async (): Promise<LivenessDecision> => {
      try {
        return await runProbe(key, probe);
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, started);
    return started;
  }

  return {
    decide(key: string, probe: LivenessProbe): Promise<LivenessDecision> {
      const previous = memo.get(key);
      if (previous !== undefined) {
        const age = now() - previous.verifiedAt;
        if (age < freshnessMs) {
          return Promise.resolve(previous.outcome);
        }
        if (age < staleAfterMs) {
          // `runProbe` translates every backend rejection into a decision, so
          // the refresh behind the served answer cannot reject.
          void probeOnce(key, probe);
          return Promise.resolve(previous.outcome);
        }
      }
      return probeOnce(key, probe);
    },
    size(): number {
      return memo.size;
    },
  };
}
