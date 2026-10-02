/**
 * A lazily-built, single-flighted value: concurrent callers share one build,
 * and a build that REJECTS is not remembered. Both thin-shell Durable Objects
 * need this shape because `ctx.id.name` is absent when the platform
 * reconstructs them, so their collaborators cannot be built in the constructor.
 *
 * Clearing the memo on rejection is the whole point: a bare `??=` remembers a
 * rejected promise, which leaves the object refusing every later request until
 * platform eviction happens to recycle it. Recovery belongs to the object, not
 * to eviction timing. The cost is that a sustained backend outage produces one
 * failing build per inbound request rather than a fast replayed refusal.
 *
 * A successor build can never be clobbered: the memo is emptied only by a
 * failing attempt, so the next build is assigned strictly after that.
 */
export class SingleFlight<T> {
  private readonly build: () => Promise<T>;
  private inFlight: Promise<T> | undefined;

  constructor(build: () => Promise<T>) {
    this.build = build;
  }

  get(): Promise<T> {
    this.inFlight ??= this.attempt();
    return this.inFlight;
  }

  private async attempt(): Promise<T> {
    try {
      return await this.build();
    } catch (error) {
      this.inFlight = undefined;
      throw error;
    }
  }
}
