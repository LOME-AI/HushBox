/**
 * The console's own launch flags, parsed from `process.argv` rather than handed
 * through Vite: `vite` rejects unknown CLI options outright, so the launcher
 * owns the flags and Vite only ever sees a config object.
 */
interface LaunchOptions {
  /** Overrides the generated port; `null` leaves `HB_DOCKET_PORT` in charge. */
  readonly port: number | null;
  /** Minutes of inactivity before the server exits; `null` disables the timer. */
  readonly idleMinutes: number | null;
  /**
   * The audit served to a request that names none; `null` takes the newest.
   * A name the console does not serve ends the launch rather than the request.
   */
  readonly audit: string | null;
}

export const DEFAULT_IDLE_MINUTES = 30;

/**
 * The console's flags and how each one's value reads, published because `--help`
 * states them and this is the file that reads them. The placeholder lives here
 * rather than at the render: `--idle` is in minutes, and a generic one erases
 * the only statement of that unit anywhere.
 */
export const LAUNCH_VALUE_FLAGS: ReadonlyMap<string, string> = new Map([
  ['--port', '<port>'],
  ['--idle', '<minutes>'],
  ['--audit', '<name>'],
]);
export const LAUNCH_BARE_FLAG = '--no-idle';

interface Mutable {
  port: number | null;
  idleMinutes: number | null;
  audit: string | null;
}

function positiveNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flag} needs a positive number, got "${raw}"`);
  }
  return value;
}

/** Reads `--flag value` and `--flag=value` alike, refusing anything unknown. */
function readValue(token: string, rest: string[]): { flag: string; value: string } {
  const equals = token.indexOf('=');
  const flag = equals === -1 ? token : token.slice(0, equals);
  if (!LAUNCH_VALUE_FLAGS.has(flag)) {
    throw new Error(`unknown option ${flag}`);
  }

  const value = equals === -1 ? (rest.shift() ?? '') : token.slice(equals + 1);
  if (value === '') {
    throw new Error(`${flag} needs a value`);
  }
  return { flag, value };
}

function apply(options: Mutable, flag: string, value: string): void {
  if (flag === '--port') {
    const port = positiveNumber(flag, value);
    if (!Number.isInteger(port)) throw new Error(`--port needs a whole number, got "${value}"`);
    options.port = port;
    return;
  }
  if (flag === '--idle') {
    options.idleMinutes = positiveNumber(flag, value);
    return;
  }
  options.audit = value;
}

export function parseLaunchOptions(argv: readonly string[]): LaunchOptions {
  const options: Mutable = { port: null, idleMinutes: DEFAULT_IDLE_MINUTES, audit: null };
  const rest = [...argv];

  while (rest.length > 0) {
    const token = rest.shift() ?? '';
    if (token === LAUNCH_BARE_FLAG) {
      options.idleMinutes = null;
      continue;
    }
    const { flag, value } = readValue(token, rest);
    apply(options, flag, value);
  }

  return options;
}
