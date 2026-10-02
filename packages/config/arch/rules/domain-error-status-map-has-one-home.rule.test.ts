import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { ALLOWED_CARRIERS } from './domain-error-status-map-has-one-home.rule.js';

function projectOf(files: Readonly<Record<string, string>>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const ELSEWHERE = 'apps/api/src/slices/chat/refusals.ts';
const CANONICAL = 'apps/api/src/lib/context/domain-error-status.ts';
const TAXONOMY = 'apps/api/src/lib/errors/domain-error.ts';

/** The base taxonomy as the real declaration spells it today. */
const BASE_CODES = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'timeout',
  'unavailable',
];

function taxonomySource(codes: readonly string[]): string {
  return `export const DOMAIN_ERROR_CODES = [
${codes.map((code) => `  '${code}',`).join('\n')}
] as const;
`;
}

/**
 * Every project the rule judges holds the taxonomy declaration, because the
 * rule reads its vocabulary from there rather than spelling it. A test that
 * varies the declaration passes its own under the same key.
 */
function projectWith(files: Readonly<Record<string, string>>): Project {
  return projectOf({ [TAXONOMY]: taxonomySource(BASE_CODES), ...files });
}

/**
 * The object-literal carrier, reconstructed from the shape that shipped
 * thirteen times. The control for the rule's first clause.
 */
const OBJECT_LITERAL_CARRIER = `
export const STATUS = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const;
`;

/**
 * The ts-pattern carrier, reconstructed from the fourteenth — the one that
 * shared almost no tokens with the other thirteen and so was invisible to the
 * duplication gate. The control for the same clause read through arms.
 */
const TS_PATTERN_CARRIER = `
import { match } from 'ts-pattern';

export function statusFor(error: { code: string }): number {
  return match(error)
    .with({ code: 'validation' }, () => 400)
    .with({ code: 'unauthorized' }, () => 401)
    .with({ code: 'forbidden' }, () => 403)
    .with({ code: 'not_found' }, () => 404)
    .with({ code: 'conflict' }, () => 409)
    .with({ code: 'rate_limited' }, () => 429)
    .with({ code: 'timeout' }, () => 408)
    .with({ code: 'unavailable' }, () => 503)
    .exhaustive();
}
`;

describe('domain-error-status-map-has-one-home', () => {
  describe('clause one — a code name in key or arm position with a status literal as its value', () => {
    it('flags a second object-literal carrier', () => {
      const violations = rule.check(projectWith({ [ELSEWHERE]: OBJECT_LITERAL_CARRIER }));

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE });
      expect(violations[0]?.message).toContain('validation');
      expect(violations[0]?.message).toContain('domain-error-status');
    });

    it('flags a second ts-pattern-chain carrier', () => {
      const violations = rule.check(projectWith({ [ELSEWHERE]: TS_PATTERN_CARRIER }));

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE });
      expect(violations[0]?.message).toContain('unavailable');
    });

    it('flags a ts-pattern carrier whose arms are bare string patterns', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { match } from 'ts-pattern';

export function statusFor(code: string): number {
  return match(code)
    .with('validation', () => 400)
    .with('unauthorized', () => 401)
    .with('forbidden', () => 403)
    .with('not_found', () => 404)
    .otherwise(() => 500);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
    });

    it('counts a code name once when the file pairs it more than once', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const STATUS = { validation: 400, unauthorized: 401 };
export const ALSO = { validation: 400, unauthorized: 401 };
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('flags a switch-case carrier', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function statusFor(code: string): number {
  switch (code) {
    case 'validation':
      return 400;
    case 'unauthorized':
      return 401;
    case 'not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'other':
      return 418;
    default:
      return 500;
  }
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('not_found');
    });

    it('flags a switch-case carrier whose labels fall through to one return', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function statusFor(code: string): number {
  switch (code) {
    case 'validation':
    case 'unauthorized':
    case 'forbidden':
    case 'conflict':
      return 400;
    default:
      return 500;
  }
}
`,
        })
      );

      expect(violations).toHaveLength(1);
    });

    it('flags a Map-entries carrier', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const STATUS = new Map<string, number>([
  ['validation', 400],
  ['unauthorized', 401],
  ['forbidden', 403],
  ['not_found', 404],
]);
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('forbidden');
    });

    it('flags a carrier assembled through Map.set calls', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
const status = new Map<string, number>();
status.set('validation', 400);
status.set('unauthorized', 401);
status.set('rate_limited', 429);
status.set('unavailable', 503);
`,
        })
      );

      expect(violations).toHaveLength(1);
    });

    it('flags a ternary-chain carrier', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function statusFor(code: string): number {
  return code === 'validation'
    ? 400
    : code === 'unauthorized'
      ? 401
      : code === 'not_found'
        ? 404
        : code === 'conflict'
          ? 409
          : 500;
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('conflict');
    });

    it('flags a carrier whose keys are quoted and whose statuses are wrapped', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const STATUS = {
  'validation': 400 as const,
  'unauthorized': (401),
  'forbidden': 403 satisfies number,
  'not_found': 404,
};
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('unauthorized');
    });

    it('flags a carrier whose pairs are sibling properties of one literal', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const UNAUTHORIZED = { allowed: false, status: 401, code: 'unauthorized' };
export const FORBIDDEN = { allowed: false, status: 403, code: 'forbidden' };
export const NOT_FOUND = { allowed: false, status: 404, code: 'not_found' };
export const CONFLICT = { allowed: false, status: 409, code: 'conflict' };
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('not_found');
    });

    it('passes sibling properties whose code name sits in a literal holding no status', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const UNAUTHORIZED = { allowed: false, code: 'unauthorized' };
export const FORBIDDEN = { allowed: false, code: 'forbidden' };
export const NOT_FOUND = { allowed: false, code: 'not_found' };
export const CONFLICT = { allowed: false, code: 'conflict' };
export const FALLBACK_STATUS = 500;
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a switch whose code-name labels reach no statement at all', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function noop(code: string): void {
  switch (code) {
    case 'validation':
    case 'unauthorized':
    case 'forbidden':
    case 'conflict':
  }
  return void 400;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a ternary chain that names codes but branches to something other than a status', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function label(code: string): string {
  return code === 'validation'
    ? 'bad request'
    : code === 'unauthorized'
      ? 'sign in'
      : code === 'not_found'
        ? 'missing'
        : code === 'conflict'
          ? 'conflict'
          : 'unknown';
}
export const TIMEOUT_NOTE = 504;
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a file holding several code names beside several status literals that pairs none of them', () => {
      const violations = rule.check(
        projectWith({
          'apps/api/src/slices/billing/adapters/payment.test.ts': `
it('declines', async () => {
  fixture.enqueueJson(400, DECLINED);
  expect(result._unsafeUnwrapErr().code).toBe('validation');
});
it('unavailable', async () => {
  fixture.enqueueJson(503, {});
  expect(result._unsafeUnwrapErr().code).toBe('unavailable');
});
it('missing', async () => {
  fixture.enqueueJson(404, {});
  expect(result._unsafeUnwrapErr().code).toBe('not_found');
});
it('slow', async () => {
  fixture.enqueueRaw(502, '');
  expect(result._unsafeUnwrapErr().code).toBe('timeout');
});
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a partial mapping below the threshold', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const PARTIAL = { validation: 400, forbidden: 403 } as const;
`,
        })
      );

      expect(violations).toEqual([]);
    });
  });

  describe('clause one, sharpened — the value IS the status, so three of them are a carrier', () => {
    it('flags a three-code object literal whose values are the statuses themselves', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const PARTIAL = { validation: 400, forbidden: 403, conflict: 409 } as const;
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE });
      expect(violations[0]?.message).toContain('conflict');
    });

    it('flags a three-arm ts-pattern chain whose arms return the status', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { match } from 'ts-pattern';

export function statusFor(error: { code: string }): number {
  return match(error)
    .with({ code: 'validation' }, () => 400)
    .with({ code: 'forbidden' }, () => 403)
    .with({ code: 'conflict' }, () => 409)
    .otherwise(() => 500);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
    });

    it('flags a three-case switch whose cases return the status from a block body', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function statusFor(code: string): number {
  switch (code) {
    case 'validation': {
      return 400;
    }
    case 'forbidden': {
      return 403;
    }
    case 'conflict': {
      return 409;
    }
    default:
      return 500;
  }
}
`,
        })
      );

      expect(violations).toHaveLength(1);
    });

    it('passes three coinciding names whose arm value is a wire refusal rather than a status', () => {
      const violations = rule.check(
        projectWith({
          'apps/api/src/slices/conversations/domain/outcomes.ts': `
import { match } from 'ts-pattern';

interface WireRefusal {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409;
}

export function refusalToWire(refusal: { refusal: string }): WireRefusal {
  return match(refusal)
    .with({ refusal: 'not-found' }, (): WireRefusal => ({ code: ERROR_CODES.NOT_FOUND, status: 404 }))
    .with({ refusal: 'forbidden' }, (): WireRefusal => ({ code: ERROR_CODES.FORBIDDEN, status: 403 }))
    .with({ refusal: 'validation' }, (): WireRefusal => ({ code: ERROR_CODES.VALIDATION, status: 400 }))
    .with({ refusal: 'conflict' }, (): WireRefusal => ({ code: ERROR_CODES.CONFLICT, status: 409 }))
    .otherwise((): WireRefusal => ({ code: ERROR_CODES.UNKNOWN, status: 400 }));
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes three per-decision constants whose status is a sibling of the code name', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const VALIDATION = { allowed: false, status: 400, code: 'validation' };
export const FORBIDDEN = { allowed: false, status: 403, code: 'forbidden' };
export const CONFLICT = { allowed: false, status: 409, code: 'conflict' };
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes code names keyed over something other than a status', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export const RETRYABLE = {
  validation: false,
  unauthorized: false,
  rate_limited: true,
  timeout: true,
  unavailable: true,
} as const;
export const DEFAULT_STATUS = 500;
export const label = (retry: boolean): string => (retry ? 'retry' : 'stop');
export const kind = (e: { code: string }): string =>
  match(e)
    .with({ code: 'timeout' }, (x) => x.code)
    .with({ code: 'unavailable' }, (x) => x.code)
    .otherwise(() => 'other');
export const REASONS = new Map<string, number>().set('unrelated', 400);
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a file whose pairs live only in comments and prose', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
/**
 * The taxonomy answers validation with 400, unauthorized with 401, forbidden
 * with 403, not_found with 404, conflict with 409 and rate_limited with 429.
 */
export const NOTE = 'see the map';
// timeout is 504 and unavailable is 503.
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a status union written in type position', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export interface Refusal {
  readonly code: 'validation' | 'unauthorized' | 'forbidden' | 'conflict';
  readonly status: 400 | 401 | 403 | 409;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });
  });

  describe('clause two — the closed set imported, statuses zipped positionally', () => {
    it('flags a carrier that spells no code name at all', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { DOMAIN_ERROR_CODES } from '../../lib/errors/index.js';

const STATUSES = [400, 401, 403, 404, 409, 429, 408, 503];

export const STATUS = Object.fromEntries(
  DOMAIN_ERROR_CODES.map((code, index) => [code, STATUSES[index]])
);
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('DOMAIN_ERROR_CODES');
    });

    it('passes a file that imports the closed set and holds no status literal', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { DOMAIN_ERROR_CODES } from '../../lib/errors/index.js';

export const COUNT = DOMAIN_ERROR_CODES.length;
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a value importer whose only 4xx/5xx numbers sit in type position', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { type DomainErrorCode, unavailableError, DOMAIN_ERROR_CODES } from '../../lib/errors/index.js';

export type Status = 400 | 503;
export const RETRIES = 3;
export const COUNT = DOMAIN_ERROR_CODES.length;
export const fail = (code: DomainErrorCode): unknown => unavailableError(code);
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('passes a type-only import of the taxonomy beside a status literal', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import type { DomainErrorCode } from '../../lib/errors/index.js';

export function fallback(code: DomainErrorCode): number {
  return code === 'unavailable' ? 503 : 500;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });
  });

  describe('the allowlist', () => {
    it('passes the canonical module carrying the map', () => {
      const violations = rule.check(projectWith({ [CANONICAL]: OBJECT_LITERAL_CARRIER }));

      expect(violations).toEqual([]);
    });

    it("passes the canonical module's own test", () => {
      const violations = rule.check(
        projectWith({
          'apps/api/src/lib/context/domain-error-status.test.ts': OBJECT_LITERAL_CARRIER,
        })
      );

      expect(violations).toEqual([]);
    });

    it('states a reason for every allowlisted path', () => {
      for (const reason of Object.values(ALLOWED_CARRIERS)) {
        expect(reason.length).toBeGreaterThan(0);
      }
      expect(Object.keys(ALLOWED_CARRIERS).length).toBeGreaterThan(0);
    });
  });

  describe('the closed code set, read from its declaration', () => {
    it('counts a code the declaration adds that the rule never spelled', () => {
      const violations = rule.check(
        projectWith({
          [TAXONOMY]: taxonomySource([...BASE_CODES, 'quota_exhausted']),
          [ELSEWHERE]: `
export const STATUS = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  quota_exhausted: 402,
} as const;
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('quota_exhausted');
    });

    it('counts only the codes the declaration spells', () => {
      const violations = rule.check(
        projectWith({
          [TAXONOMY]: taxonomySource(['validation', 'unauthorized']),
          [ELSEWHERE]: OBJECT_LITERAL_CARRIER,
        })
      );

      expect(violations).toEqual([]);
    });

    it('throws when the taxonomy module is not in the scanned tree', () => {
      expect(() => rule.check(projectOf({ [ELSEWHERE]: OBJECT_LITERAL_CARRIER }))).toThrow(
        /apps\/api\/src\/lib\/errors\/domain-error\.ts/
      );
    });

    it('throws when the taxonomy module no longer exports the closed set', () => {
      expect(() =>
        rule.check(
          projectWith({
            [TAXONOMY]: `export const BASE_CODES = ['validation', 'unauthorized'] as const;`,
            [ELSEWHERE]: OBJECT_LITERAL_CARRIER,
          })
        )
      ).toThrow(/DOMAIN_ERROR_CODES/);
    });

    it('throws when the closed set is no longer an array literal', () => {
      expect(() =>
        rule.check(
          projectWith({
            [TAXONOMY]: `export const DOMAIN_ERROR_CODES = new Set(['validation', 'unauthorized']);`,
            [ELSEWHERE]: OBJECT_LITERAL_CARRIER,
          })
        )
      ).toThrow(/DOMAIN_ERROR_CODES/);
    });

    it('throws when the closed set holds an element that is not a string literal', () => {
      expect(() =>
        rule.check(
          projectWith({
            [TAXONOMY]: `
const CARRIED_OVER = ['validation', 'unauthorized'] as const;
export const DOMAIN_ERROR_CODES = [...CARRIED_OVER, 'timeout'] as const;
`,
            [ELSEWHERE]: OBJECT_LITERAL_CARRIER,
          })
        )
      ).toThrow(/DOMAIN_ERROR_CODES/);
    });
  });

  it('reports one violation per carrier file', () => {
    const violations = rule.check(
      projectWith({
        [ELSEWHERE]: OBJECT_LITERAL_CARRIER,
        'apps/api/src/slices/media/wire.ts': TS_PATTERN_CARRIER,
      })
    );

    expect(violations).toHaveLength(2);
    expect(
      violations.map((violation) => violation.file).toSorted((a, b) => a.localeCompare(b))
    ).toEqual([ELSEWHERE, 'apps/api/src/slices/media/wire.ts']);
  });
});
