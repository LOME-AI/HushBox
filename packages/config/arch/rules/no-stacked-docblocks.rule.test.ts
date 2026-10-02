import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './no-stacked-docblocks.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const API_MODULE = 'apps/api/src/slices/chat/domain/runtime.ts';
const API_TEST_MODULE = 'apps/api/src/slices/chat/domain/runtime.test.ts';

describe('no-stacked-docblocks', () => {
  describe('the stacked pair it refuses', () => {
    it('flags two docblocks stacked above a function declaration', () => {
      const project = projectWith(
        API_MODULE,
        '/** The media pre-mint step. */\n' +
          '/** The video-progress wiring. */\n' +
          'export function attachVideoProgress(): void {}\n'
      );

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: API_MODULE, line: 2 });
      expect(violations[0]?.message).toContain('attachVideoProgress');
    });

    it('flags a stacked pair above a variable statement', () => {
      const project = projectWith(
        API_MODULE,
        '/** The cheap text model. */\n/** The prompt length. */\nconst FREEZE_PROMPT_CHARS = 4;\n'
      );

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('FREEZE_PROMPT_CHARS');
    });

    it('flags a stacked pair above a class method, which a statement-only walk cannot see', () => {
      const project = projectWith(
        API_MODULE,
        'export class Room {\n' +
          '  /** The scan the gate feeds. */\n' +
          "  /** One group's divergences. */\n" +
          '  divergences(): void {}\n' +
          '}\n'
      );

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('divergences');
    });

    it('flags a stacked pair above an interface declaration', () => {
      const project = projectWith(
        API_MODULE,
        '/** The billing slice payment seam. */\n' +
          '/** The webhook delivery lifetime. */\n' +
          'export interface PaymentProvider {\n  charge(): void;\n}\n'
      );

      const violations = rule.check(project);

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('PaymentProvider');
    });

    it('flags a pair written on one line, which has no blank line either', () => {
      const project = projectWith(
        API_MODULE,
        '/** The upper subject. */ /** The lower subject. */\nexport const value = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a plain prose block stacked above a docblock, since a note carries a subject too', () => {
      const project = projectWith(
        API_MODULE,
        '/*\n * Per-worker Postgres database.\n */\n' +
          '/** The provisioned handle. */\n' +
          'export const handle = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a pair whose upper block carries @param, a tag written for a reader', () => {
      const project = projectWith(
        API_MODULE,
        '/**\n * Widen a window.\n * @param size the width\n */\n' +
          '/** The default width. */\n' +
          'export const DEFAULT_WIDTH = 3;\n'
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('reports one violation per pair, not one per node the trivia attaches to', () => {
      const project = projectWith(
        API_MODULE,
        '/** First subject. */\n/** Second subject. */\nexport const first = (): number => 1;\n\n' +
          '/** Third subject. */\n/** Fourth subject. */\nexport const second = (): number => 2;\n'
      );

      expect(rule.check(project)).toHaveLength(2);
    });

    it("flags a stacked pair leading a file's first import, which carries no JSDoc slot", () => {
      const project = projectWith(
        API_MODULE,
        '/** The module header. */\n' +
          '/** A second subject. */\n' +
          "import { thing } from './thing.js';\n\nexport const value = thing;\n"
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a stacked pair in an api test file, where several strandings were found', () => {
      const project = projectWith(
        API_TEST_MODULE,
        '/** The five shipped rows. */\n/** A key the builder produced. */\nfunction unwrapKey(): void {}\n'
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a pair a line comment sits between, which separates neither block from the declaration', () => {
      const project = projectWith(
        API_MODULE,
        '/** The upper subject. */\n' +
          '// a note on the line below\n' +
          '/** The lower subject. */\n' +
          'export const value = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(1);
    });

    it('flags a pair a directive block sits between, which the pairing drops but the source keeps', () => {
      const project = projectWith(
        API_MODULE,
        '/** The upper subject. */\n' +
          '/* v8 ignore next -- platform dispatch */\n' +
          '/** The lower subject. */\n' +
          'export const value = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(1);
    });
  });

  describe('the shapes it passes', () => {
    it("passes the module-header shape: a block, a blank line, then the declaration's own docblock", () => {
      const project = projectWith(
        API_MODULE,
        "/**\n * The chat slice's rate-limit registry entries.\n */\n\n" +
          '/** The entry the composer reads. */\n' +
          'export const entry = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it('passes a lone docblock', () => {
      const project = projectWith(
        API_MODULE,
        '/** The only subject. */\nexport const value = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it('passes a line comment sitting directly above a docblock', () => {
      const project = projectWith(
        API_MODULE,
        '// a note\n/** The only subject. */\nexport const value = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it("passes a formatter pragma sitting directly above a declaration's own docblock", () => {
      const project = projectWith(
        API_MODULE,
        '/* prettier-ignore */\n/** The only subject. */\nexport const table = [1, 2];\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it('passes a lint pragma sitting directly below a docblock', () => {
      const project = projectWith(
        API_MODULE,
        '/** The only subject. */\n' +
          '/* eslint-disable no-secrets/no-secrets -- base64 bytes, not credentials */\n' +
          'export const asset = "AAAA";\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it('passes a coverage-ignore directive stacked with a docblock', () => {
      const project = projectWith(
        API_MODULE,
        '/* v8 ignore start -- platform dispatch */\n' +
          '/** The only subject. */\n' +
          'export function probe(): void {}\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it('passes two stacked pragmas, neither of which carries a subject', () => {
      const project = projectWith(
        API_MODULE,
        '/* eslint-disable @typescript-eslint/require-await -- async mocks */\n' +
          '/* eslint-disable sonarjs/publicly-writable-directories -- fixture paths */\n' +
          'export const value = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });

    it('passes an annotation block carrying a tool-read tag below the docblock', () => {
      const project = projectWith(
        API_MODULE,
        '/**\n * The bound ConversationRoom class behind the wrangler DO binding.\n */\n' +
          '/**\n * `wrangler.toml` binds this class by the `class_name` string.\n * @toolContract\n */\n' +
          'export const ConversationRoom = 1;\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });
  });

  describe('its scope', () => {
    it('passes a stacked pair outside the api worker, which this rule does not govern', () => {
      const project = projectWith(
        'packages/shared/src/affordability/money/tiers.ts',
        '/** Derive user tier from balance state. */\n' +
          '/** Whether a tier may call premium models. */\n' +
          'export function mayCallPremium(): boolean {\n  return true;\n}\n'
      );

      expect(rule.check(project)).toHaveLength(0);
    });
  });
});
