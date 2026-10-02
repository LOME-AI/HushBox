// A module-load hook that rewrites one file's source on its way into the
// process, so a mutation arm never touches the working tree.
//
// WHY A HOOK AND NOT A COPY. A mutated source file left behind by a killed run
// is attributed to whoever touches it next, and a copy of the tree placed where
// node cannot resolve the detector's parsers loads the regex engine instead and
// grades the wrong engine. A load hook has neither failure: the module still
// resolves from its real location, so every bare specifier underneath it
// resolves exactly as it does in a normal run, and the rewritten bytes exist
// only in memory.
//
// The arm is read from the environment variable `SOURCE_MUTATION` names, as
// JSON:
//   { "file": "<absolute path>", "from": "<exact source text>", "to": "<replacement>" }
// The path is absolute because a relative one is resolved against the working
// directory, and a hook pointed at a path that never loads applies nothing and
// reports a clean pass for a mutation that did not happen.
//
// The hook refuses an arm whose `from` is not present exactly once in the file:
// an anchor matching twice mutates a site the arm did not name, and an anchor
// matching zero times reports a clean pass for a mutation that never happened.
// Both have been observed; both throw here.

import { pathToFileURL } from 'node:url';

/** The environment variable one arm travels in, from the runner to the child. */
const SOURCE_MUTATION = 'DETECTOR_SOURCE_MUTATION';

const raw = process.env[SOURCE_MUTATION];
const spec = raw ? /** @type {{ file: string, from: string, to: string }} */ (JSON.parse(raw)) : null;
const targetUrl = spec ? pathToFileURL(spec.file).href : null;

/**
 * @param {string} url
 * @param {object} context
 * @param {(url: string, context: object) => Promise<{format: string, source: string | Uint8Array}>} nextLoad
 */
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!spec || url !== targetUrl) return loaded;
  const source =
    typeof loaded.source === 'string'
      ? loaded.source
      : Buffer.from(loaded.source).toString('utf-8');
  const occurrences = source.split(spec.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation anchor is not unique in ${spec.file}: matched ${occurrences} times, needs exactly 1`
    );
  }
  return { ...loaded, source: source.replace(spec.from, spec.to), shortCircuit: true };
}

export { SOURCE_MUTATION };
