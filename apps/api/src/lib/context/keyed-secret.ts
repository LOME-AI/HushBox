/** The configure-and-read pair for one write-once secret named by its registry entry. */
export interface KeyedSecret<Entry extends string> {
  /**
   * Puts the key in force from the environment that carries it. While no key is
   * in force, an env whose entry is absent or empty throws, naming the entry;
   * once one is, such an env is ignored, so it can never contradict the key in
   * force. A repeat of the key in force is a no-op; a different key throws,
   * naming neither value.
   */
  readonly configure: (env: Readonly<Partial<Record<Entry, string | undefined>>>) => void;
  /** The key in force; throws when nothing has configured it. */
  readonly read: () => string;
}

interface KeyedSecretSpec<Entry extends string> {
  /** The env registry entry that carries the key. */
  readonly entry: Entry;
  /** The exported function that puts the key in force; it must run before the key is used. */
  readonly configurer: string;
}

/**
 * A key set once and held for as long as the pair that holds it; a pair built at
 * module scope holds it for the life of the isolate. One isolate serves one
 * mode, so a second, different key is a composition defect rather than a
 * reconfiguration.
 */
export function createKeyedSecret<Entry extends string>(
  spec: KeyedSecretSpec<Entry>
): KeyedSecret<Entry> {
  let secret: string | undefined;
  const { entry, configurer } = spec;
  return {
    configure: (env) => {
      const raw: string | undefined = env[entry];
      if (secret === undefined) {
        if (raw === undefined || raw === '') {
          throw new Error(
            `${entry} is missing: every mode declares it in the env registry — ` +
              'set it in wrangler config / .dev.vars rather than falling back to a literal.'
          );
        }
        secret = raw;
        return;
      }
      if (raw === undefined || raw === '') return;
      if (raw !== secret) {
        throw new Error(
          `${entry} disagrees with the key already in force — one process serves one mode, so ` +
            'two values is a composition defect.'
        );
      }
    },
    read: () => {
      if (secret === undefined) {
        throw new Error(
          `${entry} is not configured: it reaches its module through ${configurer}, which must ` +
            'run before the key is used.'
        );
      }
      return secret;
    },
  };
}
