export default {
  'apps/api/**/*.ts': (files) =>
    `pnpm --filter @hushbox/api exec eslint --fix ${files.join(' ')}`,
  'apps/web/**/*.{ts,tsx}': (files) =>
    `pnpm --filter @hushbox/web exec eslint --fix ${files.join(' ')}`,
  'packages/db/**/*.ts': (files) =>
    `pnpm --filter @hushbox/db exec eslint --fix ${files.join(' ')}`,
  'packages/shared/**/*.ts': (files) =>
    `pnpm --filter @hushbox/shared exec eslint --fix ${files.join(' ')}`,
  'packages/ui/**/*.{ts,tsx}': (files) =>
    `pnpm --filter @hushbox/ui exec eslint --fix ${files.join(' ')}`,
  'packages/config/**/*.{js,ts}': (files) =>
    `pnpm --filter @hushbox/config exec eslint --fix ${files.join(' ')}`,
  'scripts/**/*.ts': (files) =>
    `pnpm --filter @hushbox/scripts exec eslint --fix ${files.join(' ')}`,
  'e2e/**/*.ts': (files) => `pnpm --filter @hushbox/e2e exec eslint --fix ${files.join(' ')}`,
  '*.{json,md,yaml,yml,css}': ['prettier --write'],
  'package.json': ['prettier --write'],
};
