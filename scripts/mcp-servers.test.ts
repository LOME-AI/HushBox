import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const LAUNCHER = '.mcp.json';

/**
 * The stdio servers that exist today. Every per-server case derives its subject
 * from the launcher configuration, so a discovery bug that found nothing would
 * pass each of them over an empty set; this list is the floor that fails. A
 * count cannot serve — the servers it names could be swapped for others
 * without moving it.
 */
const KNOWN_STDIO_SERVERS: readonly string[] = ['playwright', 'shadcn', 'chrome-devtools'];

const ServerShape = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
});

const LauncherShape = z.object({ mcpServers: z.record(z.string(), ServerShape) });

type Server = z.infer<typeof ServerShape>;

function declaredServers(): Record<string, Server> {
  const source = readFileSync(path.join(REPO_ROOT, LAUNCHER), 'utf8');
  return LauncherShape.parse(JSON.parse(source)).mcpServers;
}

/**
 * The servers Claude Code starts by running a local command, so their entry
 * point is a path this module can check. An entry declaring no transport type
 * is one of them: absence is this format's default for stdio, not a gap, and
 * every remote transport declares its own type. An entry admitted here that
 * names no node entry point fails the entry-point cases rather than dropping
 * out of them unchecked.
 */
function stdioServers(servers: Record<string, Server>): Record<string, Server> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([, server]) => server.type === undefined || server.type === 'stdio'
    )
  );
}

/**
 * The script node runs, which is the first argument node does not read as a
 * flag. Derived rather than indexed so a server carrying a node flag ahead of
 * its entry point still resolves to the entry point.
 */
function entryPoint(args: readonly string[]): string | undefined {
  return args.find((argument) => !argument.startsWith('-'));
}

const stdio = stdioServers(declaredServers());
const serverNames = Object.keys(stdio);

describe('the launcher configuration', () => {
  it('starts every tool server this repository launches locally', () => {
    expect(serverNames).toEqual(expect.arrayContaining([...KNOWN_STDIO_SERVERS]));
  });

  describe('which entries it reads as stdio', () => {
    it('reads an entry that declares a command and no transport type', () => {
      const derived = stdioServers({
        typeless: { command: 'node', args: ['node_modules/somewhere/entry.js'] },
      });

      expect(Object.keys(derived)).toEqual(['typeless']);
    });

    it('leaves an entry that declares a remote transport to its own endpoint', () => {
      const derived = stdioServers({
        remote: { type: 'http', url: 'https://example.invalid/mcp' },
      });

      expect(Object.keys(derived)).toEqual([]);
    });
  });

  describe.each(serverNames)('%s', (name) => {
    const server = stdio[name];

    it('launches through node, so its entry point is a path and not an indirection', () => {
      expect(server?.command).toBe('node');
    });

    it('names an entry point that exists', () => {
      // These servers are started by a path into the installed package rather
      // than by the package's declared binary, and their versions are declared
      // as ranges. An in-range publish that relocates the entry point stops the
      // server silently: no install error, no failing tool call, nothing else
      // in the repository reads these paths.
      const entry = entryPoint(server?.args ?? []);
      expect(entry, `${name} names no entry point in ${LAUNCHER}`).toBeDefined();
      expect(
        existsSync(path.join(REPO_ROOT, entry ?? '')),
        `${LAUNCHER} starts ${name} from ${String(entry)}, which does not exist`
      ).toBe(true);
    });
  });
});
