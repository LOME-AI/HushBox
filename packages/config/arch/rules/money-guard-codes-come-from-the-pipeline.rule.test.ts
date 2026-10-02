import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './money-guard-codes-come-from-the-pipeline.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const MINTER_PATH = 'apps/api/src/middleware/rate-limit.ts';
const STAGE_PATH = 'apps/api/src/middleware/pipeline-rate-limit.ts';
const BILLING_PATH = 'apps/api/src/slices/billing/domain/charge.ts';
const CHAT_PATH = 'apps/api/src/slices/chat/domain/turn.ts';

describe('money-guard-codes-come-from-the-pipeline', () => {
  it('accepts the minting file naming the code it owns', () => {
    const project = projectWith({
      [MINTER_PATH]: `const stamped = { wireCode: ERROR_CODES.RATE_LIMIT_UNAVAILABLE };\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a slice naming the limiter-unavailable code through the registry', () => {
    const project = projectWith({
      [BILLING_PATH]: `const refusal = createErrorResponse(ERROR_CODES.RATE_LIMIT_UNAVAILABLE);\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BILLING_PATH });
    expect(violations[0]?.message).toMatch(/RATE_LIMIT_UNAVAILABLE/);
  });

  it('flags a slice naming the limiter-unavailable code as a bare string', () => {
    const project = projectWith({
      [CHAT_PATH]: `const code = 'RATE_LIMIT_UNAVAILABLE';\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a slice naming the limiter-unavailable code as an untagged template', () => {
    const project = projectWith({
      [CHAT_PATH]: 'const code = `RATE_LIMIT_UNAVAILABLE`;\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a slice naming an unguarded code', () => {
    const project = projectWith({
      [BILLING_PATH]: `const refusal = createErrorResponse(ERROR_CODES.UNAVAILABLE);\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a test file naming the code, which asserts rather than emits', () => {
    const project = projectWith({
      [`${BILLING_PATH.replace('.ts', '')}.test.ts`]: `expect(body.code).toBe('RATE_LIMIT_UNAVAILABLE');\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the pipeline stage calling the refusal producer', () => {
    const project = projectWith({
      [STAGE_PATH]: `const refusal = rateLimitRefusal(c, decision);\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a slice calling the refusal producer from outside the pipeline', () => {
    const project = projectWith({
      [CHAT_PATH]: `const refusal = rateLimitRefusal(c, decision);\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CHAT_PATH });
    expect(violations[0]?.message).toMatch(/rateLimitRefusal/);
  });

  it('accepts every written form spelling something other than a guarded code', () => {
    const project = projectWith({
      [BILLING_PATH]: [
        `const viaRegistry = ERROR_CODES.PAYMENT_DECLINED;`,
        `const viaString = 'PAYMENT_DECLINED';`,
        'const viaTemplate = `PAYMENT_DECLINED`;',
        '',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags the billing slice naming the over-cap code', () => {
    const project = projectWith({
      [BILLING_PATH]: `const refusal = createErrorResponse(ERROR_CODES.RATE_LIMITED, { retryAfterSeconds });\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BILLING_PATH });
    expect(violations[0]?.message).toMatch(/RATE_LIMITED/);
  });

  it('flags the billing slice building a rate-limited domain error', () => {
    const project = projectWith({
      [BILLING_PATH]: `return err(rateLimitedError('too many charge attempts'));\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BILLING_PATH });
    expect(violations[0]?.message).toMatch(/rateLimitedError/);
  });

  it('accepts the chat slice naming the over-cap code in every written form', () => {
    const project = projectWith({
      [CHAT_PATH]: [
        `const viaRegistry = ERROR_CODES.RATE_LIMITED;`,
        `const viaString = 'RATE_LIMITED';`,
        'const viaTemplate = `RATE_LIMITED`;',
        '',
      ].join('\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the chat slice building a rate-limited domain error', () => {
    const project = projectWith({
      [CHAT_PATH]: `return err(rateLimitedError('too many runs'));\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes over a call whose callee is not a written-out name', () => {
    const project = projectWith({
      [CHAT_PATH]: `const refusal = limiter.rateLimitRefusal(c, decision);\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves trees outside the product Worker alone', () => {
    const project = projectWith({
      'apps/web/src/components/billing/payment-form.tsx': `const code = 'RATE_LIMIT_UNAVAILABLE';\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });
});
