import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse, type TomlTable, type TomlValue } from 'smol-toml';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const API_WRANGLER = path.join(REPO_ROOT, 'apps', 'api', 'wrangler.toml');

/**
 * The derivation rather than one example of it: a route list or a count would
 * rot as routes move, and reads as though reshaping the named route unblocks
 * the flag. Nothing here is reshapeable — a share URL is the capability, and
 * the header a WebSocket cannot send is a browser limitation.
 */
const PIN_REASON =
  'Two independent reasons hold this off, so switching invocation logs off on their own does ' +
  'not answer it. Invocation logs: Cloudflare publishes no field-level schema for them and ' +
  'offers no redaction, field-scrubbing, or URL-masking control, so what the stream captures ' +
  'is undocumented and can change without notice. This API carries live credentials in its ' +
  'URLs by construction: a share URL is itself the capability, and a browser WebSocket cannot ' +
  'set headers, so guest and trial credentials ride query-parameter fallbacks. A logging ' +
  'premise built on content being unrepresentable cannot admit an unspecified, unscrubbable ' +
  'vendor payload into the same path. Custom logs: enabling them buys retention with no push ' +
  'channel behind it, and a stream that must be visited is visited never - a metric names its ' +
  'watcher or it does not ship.';

const WITHOUT_BLOCK = ['[dev]', 'local_protocol = "http"', '', '[limits]', 'cpu_ms = 30000'].join(
  '\n'
);

const ENABLED = ['[observability]', 'enabled = true', '', '[limits]', 'cpu_ms = 30000'].join('\n');

const ENABLED_NOT_A_BOOLEAN = ['[observability]', 'enabled = "false"'].join('\n');

const ENV_OVERRIDE = [
  '[observability]',
  'enabled = false',
  '',
  '[env.production]',
  '',
  '[env.production.observability]',
  'enabled = true',
].join('\n');

const SUB_TABLE = [
  '[observability]',
  'enabled = false',
  '',
  '[observability.logs]',
  'invocation_logs = true',
].join('\n');

const LOGPUSH = ['logpush = true', '', '[observability]', 'enabled = false'].join('\n');

const DOTTED_KEY_IN_BLOCK = [
  '[observability]',
  'enabled = false',
  'logs.invocation_logs = true',
].join('\n');

const BARE_ENV_HEADER = [
  '[observability]',
  'enabled = false',
  '',
  '[env]',
  'production.observability.enabled = true',
].join('\n');

const TOP_LEVEL_DOTTED_KEY = [
  'env.production.observability.enabled = true',
  '',
  '[observability]',
  'enabled = false',
].join('\n');

const INLINE_TABLE = [
  '[observability]',
  'enabled = false',
  'logs = { invocation_logs = true }',
].join('\n');

const QUOTED_KEY_SEGMENT = [
  '[observability]',
  'enabled = false',
  'logs."invocation_logs" = true',
].join('\n');

const SPACED_DOTTED_KEY = [
  '[observability]',
  'enabled = false',
  'logs . invocation_logs = true',
].join('\n');

const QUOTED_HEADER_SEGMENT = [
  '[observability]',
  'enabled = false',
  '',
  '["observability".logs]',
  'invocation_logs = true',
].join('\n');

const QUOTED_LOGPUSH = ['"logpush" = true', '', '[observability]', 'enabled = false'].join('\n');

const TAIL_CONSUMER = [
  '[observability]',
  'enabled = false',
  '',
  '[[tail_consumers]]',
  'service = "log-sink"',
].join('\n');

const STREAMING_TAIL_CONSUMER = [
  '[observability]',
  'enabled = false',
  '',
  '[[streaming_tail_consumers]]',
  'service = "log-sink"',
].join('\n');

const LOGFWDR = [
  '[observability]',
  'enabled = false',
  '',
  '[[logfwdr.bindings]]',
  'name = "sink"',
  'destination = "log-sink"',
].join('\n');

const UNPARSEABLE = ['[observability]', 'enabled = false', 'this line is not toml'].join('\n');

/**
 * The config as Wrangler reads it — `smol-toml` is the parser Wrangler
 * bundles, so what the assertions below refuse is the shape a deploy would see
 * rather than the spelling someone happened to type.
 *
 * A file the parser rejects is refused, not admitted: the pin cannot be read
 * off a config nothing can read, and admitting one would make an unparseable
 * file the way past every assertion.
 */
function parseOrRefuse(toml: string): TomlTable {
  try {
    return parse(toml);
  } catch {
    return expect.fail(PIN_REASON);
  }
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Every key path the config states, at every depth. Table keys are emitted in
 * their own right, so a table is visible whether or not it has children, and
 * an array's elements extend no path — an array of tables states the same key
 * names a single table would, and the index is not part of the refused shape.
 */
function keyPaths(value: TomlValue): readonly (readonly string[])[] {
  if (Array.isArray(value)) return value.flatMap((element) => keyPaths(element));
  if (!isTable(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => [
    [key],
    ...keyPaths(child).map((suffix) => [key, ...suffix]),
  ]);
}

/** The paths of every key with this name, wherever in the config it sits. */
function keysNamed(config: TomlTable, name: string): readonly string[] {
  return keyPaths(config)
    .filter((keyPath) => keyPath.at(-1) === name)
    .map((keyPath) => keyPath.join('.'));
}

/**
 * The keys that route this Worker's Trace Events to something else: Logpush to
 * a destination, a tail consumer or a streaming tail consumer to another
 * Worker that can do anything with what it receives, and `logfwdr` to a
 * forwarding destination. Each carries the same undocumented vendor payload to
 * a second reader, and each opens without touching `[observability]` at all.
 */
const EVENT_ROUTING_KEYS = [
  'logpush',
  'tail_consumers',
  'streaming_tail_consumers',
  'logfwdr',
] as const;

/** The paths of every event-routing key the config states. */
function eventRoutingKeys(config: TomlTable): readonly string[] {
  return EVENT_ROUTING_KEYS.flatMap((name) => keysNamed(config, name));
}

/** The block's `enabled`, or `undefined` when the block or the key is absent. */
function statedEnabled(config: TomlTable): TomlValue | undefined {
  const block = config['observability'];
  return isTable(block) ? block['enabled'] : undefined;
}

/** The block's keys other than `enabled`. */
function otherObservabilityKeys(config: TomlTable): readonly string[] {
  const block = config['observability'];
  return isTable(block) ? Object.keys(block).filter((key) => key !== 'enabled') : [];
}

/**
 * What this guard covers is the assertions below; what it does not cover is
 * stated here, because a partial guard believed total is worse than none.
 *
 * Because it reads the parsed config rather than raw lines, spelling is out of
 * scope: a sub-table header, a dotted key, an inline table, a quoted key or
 * header segment and spaces around a dot all resolve to the same object, and
 * one assertion on that object refuses them all at once. There is no spelling
 * of these settings left to enumerate.
 *
 * Coverage past spelling is by name, and names are a floor: the settings
 * refused below are the ones enumerated below, so a key Cloudflare adds to the
 * schema later reaches a deploy unrefused until someone adds it here.
 *
 * Two things cannot land in this file at all, and neither is refused here
 * because neither is here to read: a config that is not this one — a
 * `wrangler.json` or `.jsonc`, or another path handed to `--config` — and a
 * setting supplied on the deploy command line instead of written down. Only
 * the narrow case of this file being deleted or renamed fails closed, on the
 * read throwing.
 */
function assertObservabilityPinned(toml: string): void {
  const config = parseOrRefuse(toml);

  // Absence is refused alongside `true`: what Wrangler does with the block or
  // the key missing is not established, and demanding an explicit `false`
  // holds under either default.
  expect(statedEnabled(config), PIN_REASON).toBe(false);

  // Any second key in the block reaches an `[observability.*]` setting the
  // top-level pin does not cover — `logs.invocation_logs` above all. Whether
  // one of those overrides a top-level `false` is not something Cloudflare
  // documents, and that is the reason to refuse the shape outright rather than
  // interpret it.
  expect(otherObservabilityKeys(config), PIN_REASON).toEqual([]);

  // Every door out of the Worker, not only the one `[observability]` guards:
  // each of these hands the same undocumented vendor payload to a second
  // reader, so a config opening one has to be weighed against PIN_REASON
  // rather than bypass it.
  expect(eventRoutingKeys(config), PIN_REASON).toEqual([]);

  // The environment refusal is deliberately broader than logging: an override
  // table can reintroduce any of the above, so what this asserts is that the
  // file stays the shape the pin was reasoned about, and an override has to be
  // weighed against that argument rather than silently bypass it.
  expect(keysNamed(config, 'env'), PIN_REASON).toEqual([]);
}

describe('product Worker observability', () => {
  it('is pinned off in the committed config', () => {
    assertObservabilityPinned(readFileSync(API_WRANGLER, 'utf8'));
  });

  it('refuses a config that omits the block', () => {
    expect(() => {
      assertObservabilityPinned(WITHOUT_BLOCK);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config that enables it', () => {
    expect(() => {
      assertObservabilityPinned(ENABLED);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config whose enabled is not the boolean false', () => {
    expect(() => {
      assertObservabilityPinned(ENABLED_NOT_A_BOOLEAN);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying an environment section', () => {
    expect(() => {
      assertObservabilityPinned(ENV_OVERRIDE);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying an observability sub-table', () => {
    expect(() => {
      assertObservabilityPinned(SUB_TABLE);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a bare environment header', () => {
    expect(() => {
      assertObservabilityPinned(BARE_ENV_HEADER);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a dotted key inside the block', () => {
    expect(() => {
      assertObservabilityPinned(DOTTED_KEY_IN_BLOCK);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a top-level dotted environment key', () => {
    expect(() => {
      assertObservabilityPinned(TOP_LEVEL_DOTTED_KEY);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a logpush key', () => {
    expect(() => {
      assertObservabilityPinned(LOGPUSH);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying an inline table in the block', () => {
    expect(() => {
      assertObservabilityPinned(INLINE_TABLE);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a quoted key segment in the block', () => {
    expect(() => {
      assertObservabilityPinned(QUOTED_KEY_SEGMENT);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying spaces around a dotted key in the block', () => {
    expect(() => {
      assertObservabilityPinned(SPACED_DOTTED_KEY);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a quoted first header segment', () => {
    expect(() => {
      assertObservabilityPinned(QUOTED_HEADER_SEGMENT);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a quoted logpush key', () => {
    expect(() => {
      assertObservabilityPinned(QUOTED_LOGPUSH);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a tail consumer', () => {
    expect(() => {
      assertObservabilityPinned(TAIL_CONSUMER);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a streaming tail consumer', () => {
    expect(() => {
      assertObservabilityPinned(STREAMING_TAIL_CONSUMER);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config carrying a logfwdr binding', () => {
    expect(() => {
      assertObservabilityPinned(LOGFWDR);
    }).toThrow(PIN_REASON);
  });

  it('refuses a config the parser rejects', () => {
    expect(() => {
      assertObservabilityPinned(UNPARSEABLE);
    }).toThrow(PIN_REASON);
  });
});
