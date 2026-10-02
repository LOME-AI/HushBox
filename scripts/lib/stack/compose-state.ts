/**
 * Whether the containers that are up are the ones the compose file describes.
 *
 * Health was the old answer and it is the wrong one: a container edited in the
 * compose file stays healthy under its old environment, mounts and image, so a
 * bring-up skipped on health silently keeps serving stale configuration. Compose
 * itself decides recreation by comparing the `com.docker.compose.config-hash`
 * label it stamped on the container against the hash it computes for the
 * service now, and that is the comparison here.
 *
 * Every uncertainty resolves toward doing the work: a service that is absent,
 * unhealthy, unlabelled, or one compose could compute no hash for is treated as
 * needing a bring-up, which is idempotent.
 */

/** The label list is a comma-separated `key=value` run, so the key anchors on one. */
const CONFIG_HASH_PATTERN = new RegExp(
  String.raw`(?:^|,)com\.docker\.compose\.config-hash=([^,]*)`
);

interface ComposeService {
  readonly service: string;
  /** Empty for a service that declares no healthcheck. */
  readonly health: string;
  readonly state: string;
  /** The hash of the configuration this container was created from. */
  readonly configHash: string | null;
}

interface ComposePsRow {
  Service: string;
  Health?: string;
  State?: string;
  Labels?: string;
}

/**
 * Label values carry commas of their own — one image here describes itself in a
 * sentence — so the list is searched for the key rather than split on the
 * separator.
 */
export function configHashOf(labels: string): string | null {
  return CONFIG_HASH_PATTERN.exec(labels)?.[1] ?? null;
}

/** `docker compose ps --format json`, in either the per-line or array form. */
export function parseComposePs(stdout: string): ComposeService[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  const rows: ComposePsRow[] = trimmed.startsWith('[')
    ? (JSON.parse(trimmed) as ComposePsRow[])
    : trimmed.split('\n').map((line) => JSON.parse(line) as ComposePsRow);

  return rows.map((row) => ({
    service: row.Service,
    health: row.Health ?? '',
    state: row.State ?? '',
    configHash: configHashOf(row.Labels ?? ''),
  }));
}

/** `docker compose config --hash '*'`, one `<service> <hash>` line each. */
export function parseComposeHashes(stdout: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [service, hash] = line.trim().split(/\s+/);
    if (service === undefined || service === '' || hash === undefined) continue;
    hashes.set(service, hash);
  }
  return hashes;
}

function isUp(found: ComposeService): boolean {
  // A service without a healthcheck reports no health, so running is the only
  // liveness signal it has.
  return found.health === 'healthy' || (found.health === '' && found.state === 'running');
}

export function servicesMatchConfig(
  required: readonly string[],
  running: readonly ComposeService[],
  hashes: ReadonlyMap<string, string>
): boolean {
  const byService = new Map(running.map((found) => [found.service, found]));
  return required.every((service) => {
    const found = byService.get(service);
    const wanted = hashes.get(service);
    if (found === undefined || wanted === undefined) return false;
    return isUp(found) && found.configHash === wanted;
  });
}
