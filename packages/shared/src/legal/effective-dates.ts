import { z } from 'zod';

/**
 * The effective date each published legal document carries, taken from the
 * build that produced this bundle rather than from anything written here.
 *
 * `scripts/legal-effective-dates.ts` derives each date from the release tags —
 * the day of the earliest release whose commit already declared the document's
 * current revision — and the deploy pipeline binds the answers to the two
 * variables read below, exactly as it binds the version. A human raises the
 * revision integer beside the document's copy when a change is substantive, and
 * that judgement is the only human input: no date is typed, here or anywhere.
 *
 * Read when a date is asked for rather than when this module loads, because
 * both reads are of a global only a bundler defines. `../index.ts` re-exports
 * these documents, and `scripts/lib/backup/run.ts` imports that barrel under
 * plain Node to read the Privacy Policy's sections — so importing this module
 * has to cost nothing there, and a context with no injected date has to say so
 * rather than fail on the global's own absence.
 *
 * Each variable is named literally at its read: bundlers resolve `import.meta.env`
 * by statically replacing literal access, so a key reaching it as a variable
 * reads nothing (`../env/require-env.ts` states the same constraint at greater
 * length). Astro's build-time frontmatter is the strictest
 * case — there the runtime object holds no `VITE_*` key at all, and only the
 * replaced access carries a value, which is why neither read may be routed
 * through a captured object or an optional chain.
 */

/**
 * The two keys this module reads off the bundler's environment global, declared
 * here because this package depends on no bundler's types and every package that
 * compiles these sources — the product Worker's and the script tree's among them
 * — would otherwise reject the reads. Declared as the two named keys rather than
 * as an index signature, so that a package which DOES carry `vite/client` merges
 * these in beside its own declaration instead of colliding with it.
 */
declare global {
  interface ImportMetaEnv {
    readonly VITE_PRIVACY_POLICY_EFFECTIVE_DATE?: string;
    readonly VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A day the calendar has. The shape alone admits `2019-02-30`, which `Date`
 * silently moves into March — so the day is round-tripped, and a value that
 * comes back as some other day is refused rather than published as that day.
 */
const injectedEffectiveDate = z
  .string()
  .regex(ISO_DAY, 'is not written as a day, YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'is written as a day the calendar does not have');

/** What `read` yields, or nothing where no bundler defined the global it reads. */
function injected(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    /* v8 ignore start -- @preserve every bundler defines `import.meta.env`, and so does the test
       runner, so no test process reaches this arm; it is reached by importing the package barrel
       under plain Node, where it was driven directly */
    return undefined;
    /* v8 ignore stop */
  }
}

/** The injected value, or a refusal naming the variable, what it carried and what it must be. */
function effectiveDate(name: string, read: () => unknown): string {
  const value = injected(read);
  const parsed = injectedEffectiveDate.safeParse(value);
  if (parsed.success) return parsed.data;

  const carried = typeof value === 'string' ? `\`${value}\`` : 'nothing at all';
  const why = parsed.error.issues.map((issue) => issue.message).join('; ');
  throw new Error(
    `${name} ${why}. It carried ${carried}. The deploy pipeline injects this from the release ` +
      'tags; run pnpm generate:env, or check the step that binds it in the build workflow.'
  );
}

/** The day this build publishes as the Privacy Policy's effective date. */
export function privacyPolicyEffectiveDate(): string {
  return effectiveDate(
    'VITE_PRIVACY_POLICY_EFFECTIVE_DATE',
    () => import.meta.env.VITE_PRIVACY_POLICY_EFFECTIVE_DATE
  );
}

/** The day this build publishes as the Terms of Service's effective date. */
export function termsOfServiceEffectiveDate(): string {
  return effectiveDate(
    'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE',
    () => import.meta.env.VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE
  );
}
