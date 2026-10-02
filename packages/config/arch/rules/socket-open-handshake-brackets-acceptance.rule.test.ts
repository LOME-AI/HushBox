import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './socket-open-handshake-brackets-acceptance.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const SHELL_PATH = 'packages/realtime/src/shell.ts';

/** The compliant shape, written as the shell's own upgrade handler. */
function shell(body: string): Project {
  return projectWith({
    [SHELL_PATH]: `class Shell {
  private async upgrade(): Promise<Response> {
${body}
  }
}
`,
  });
}

const COMPLIANT = `    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`;

describe('socket-open-handshake-brackets-acceptance', () => {
  it('allows the handshake that brackets acceptance without yielding', () => {
    expect(rule.check(shell(COMPLIANT))).toEqual([]);
  });

  it('flags an await between acceptance and the open completion', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    await this.telemetry.flush();
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: SHELL_PATH, line: 5 });
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('flags an await between the open completion and the upgrade response', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    await this.telemetry.flush();
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('flags an awaited iteration after acceptance', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    for await (const entry of this.pending) this.replay(entry);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('flags an awaited disposal after acceptance', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    await using span = this.telemetry.span();
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('allows an await inside a callback declared after acceptance', () => {
    expect(
      rule.check(
        shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    this.ctx.waitUntil((async () => { await this.telemetry.flush(); })());
    return new Response(null, { status: 101, webSocket: client });`)
      )
    ).toEqual([]);
  });

  it('flags an acceptance no open completion follows', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: SHELL_PATH, line: 4 });
    expect(violations[0]?.message).toMatch(/completeOpen/);
  });

  it('flags an open completion deferred out of the accepting turn', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    queueMicrotask(() => { core.completeOpen(socket, declared); });
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/completeOpen/);
  });

  it('flags an open completion written before acceptance', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    core.completeOpen(socket, declared);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/completeOpen/);
  });

  it('flags setup preparation that acceptance precedes', () => {
    const violations = rule.check(
      shell(`    this.ctx.acceptWebSocket(server);
    await core.prepareOpen(socket);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations.map((violation) => violation.message).join('\n')).toMatch(/prepareOpen/);
  });

  it('flags setup preparation nothing awaits', () => {
    const violations = rule.check(
      shell(`    core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/prepareOpen/);
  });

  it('flags an acceptance with no setup preparation at all', () => {
    const violations = rule.check(
      shell(`    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/prepareOpen/);
  });

  it('reads a parenthesized awaited preparation as awaited', () => {
    expect(
      rule.check(
        shell(`    await (core.prepareOpen(socket));
    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
      )
    ).toEqual([]);
  });

  it('judges each acceptance in a file on its own handshake', () => {
    const violations = rule.check(
      projectWith({
        [SHELL_PATH]: `class Shell {
  private async upgrade(): Promise<Response> {
${COMPLIANT}
  }

  private async upgradeGuest(): Promise<Response> {
    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    await this.telemetry.flush();
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });
  }
}
`,
      })
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('judges an acceptance written at module scope against the module', () => {
    const compliant = `await core.prepareOpen(socket);
ctx.acceptWebSocket(server);
core.completeOpen(socket, declared);
`;

    expect(rule.check(projectWith({ [SHELL_PATH]: compliant }))).toEqual([]);
    expect(
      rule.check(projectWith({ [SHELL_PATH]: `${compliant}await telemetry.flush();\n` }))
    ).toHaveLength(1);
  });

  it('ignores an acceptance written in a test file', () => {
    expect(
      rule.check(
        projectWith({
          [SHELL_PATH]: `class Shell {
  private async upgrade(): Promise<Response> {
${COMPLIANT}
  }
}
`,
          'packages/realtime/src/shell.test.ts':
            'it("accepts", async () => {\n  ctx.acceptWebSocket(server);\n  await settle();\n});\n',
        })
      )
    ).toEqual([]);
  });

  it('ignores an acceptance outside the realtime source tree', () => {
    expect(
      rule.check(
        projectWith({
          [SHELL_PATH]: `class Shell {
  private async upgrade(): Promise<Response> {
${COMPLIANT}
  }
}
`,
          'apps/api/src/lib/probe.ts':
            'export async function probe(): Promise<void> {\n  ctx.acceptWebSocket(server);\n  await settle();\n}\n',
        })
      )
    ).toEqual([]);
  });

  it('flags an awaited acceptance', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    await this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: SHELL_PATH, line: 4 });
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('flags an acceptance wrapped in an awaited expression', () => {
    const violations = rule.check(
      shell(`    await core.prepareOpen(socket);
    await Promise.resolve(this.ctx.acceptWebSocket(server));
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/nothing may be awaited/);
  });

  it('allows an await the acceptance itself consumes', () => {
    expect(
      rule.check(
        shell(`    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(await this.tagged(server));
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
      )
    ).toEqual([]);
  });

  it('allows an await written before the fallible half', () => {
    expect(
      rule.check(
        shell(`    const { core } = await this.ensureRoom();
    await core.prepareOpen(socket);
    this.ctx.acceptWebSocket(server);
    core.completeOpen(socket, declared);
    return new Response(null, { status: 101, webSocket: client });`)
      )
    ).toEqual([]);
  });

  it('allows an await in a sibling method the acceptance is not in', () => {
    expect(
      rule.check(
        projectWith({
          [SHELL_PATH]: `class Shell {
  private async upgrade(): Promise<Response> {
${COMPLIANT}
  }

  private async close(): Promise<void> {
    await this.core.closeSocket(socket);
  }
}
`,
        })
      )
    ).toEqual([]);
  });

  it('throws when the realtime tree accepts no socket', () => {
    expect(() =>
      rule.check(
        projectWith({
          'packages/realtime/src/room-core.ts': 'export class RoomCore {}\n',
        })
      )
    ).toThrow(/accepts no socket/);
  });

  describe('against the live shell it must reach', () => {
    const SHELL = 'packages/realtime/src/conversation-room.ts';
    const source = readFileSync(path.join(REPO_ROOT, SHELL), 'utf8');

    it('passes the shell as written', () => {
      expect(rule.check(projectWith({ [SHELL]: source }))).toEqual([]);
    });

    it('flags the shell once the acceptance itself is awaited', () => {
      const yielded = source.replace(
        '      this.ctx.acceptWebSocket(server);',
        '      await this.ctx.acceptWebSocket(server);'
      );
      expect(yielded).not.toBe(source);

      const violations = rule.check(projectWith({ [SHELL]: yielded }));

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/nothing may be awaited/);
    });

    it('flags the shell once the acceptance is wrapped in an awaited expression', () => {
      const yielded = source.replace(
        '      this.ctx.acceptWebSocket(server);',
        '      await Promise.resolve(this.ctx.acceptWebSocket(server));'
      );
      expect(yielded).not.toBe(source);

      const violations = rule.check(projectWith({ [SHELL]: yielded }));

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/nothing may be awaited/);
    });

    it('flags the shell once an await separates acceptance from the open completion', () => {
      const yielded = source.replace('      core.completeOpen(', '      await core.completeOpen(');
      expect(yielded).not.toBe(source);

      const violations = rule.check(projectWith({ [SHELL]: yielded }));

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toMatch(/nothing may be awaited/);
    });
  });
});
