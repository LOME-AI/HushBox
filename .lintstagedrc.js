export default {
  'apps/api/**/*.ts': (files) =>
    `pnpm --filter @lome-chat/api exec eslint --fix ${files.join(' ')}`,
  'apps/web/**/*.{ts,tsx}': (files) =>
    `pnpm --filter @lome-chat/web exec eslint --fix ${files.join(' ')}`,
  'packages/db/**/*.ts': (files) =>
    `pnpm --filter @lome-chat/db exec eslint --fix ${files.join(' ')}`,
  'packages/shared/**/*.ts': (files) =>
    `pnpm --filter @lome-chat/shared exec eslint --fix ${files.join(' ')}`,
  'packages/ui/**/*.{ts,tsx}': (files) =>
    `pnpm --filter @lome-chat/ui exec eslint --fix ${files.join(' ')}`,
  'packages/config/**/*.{js,ts}': (files) =>
    `pnpm --filter @lome-chat/config exec eslint --fix ${files.join(' ')}`,
  'scripts/**/*.ts': (files) =>
    `pnpm --filter @lome-chat/scripts exec eslint --fix ${files.join(' ')}`,
  'e2e/**/*.ts': (files) =>
    `pnpm --filter @lome-chat/e2e exec eslint --fix ${files.join(' ')}`,
  '*.{json,md,yaml,yml,css}': ['prettier --write'],
  'package.json': ['prettier --write'],
};
