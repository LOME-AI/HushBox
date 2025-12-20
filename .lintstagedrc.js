export default {
  '*.{ts,tsx,js,jsx,mjs,cjs}': ['eslint --fix --no-warn-ignored', 'prettier --write'],
  '*.{json,md,yaml,yml,css}': ['prettier --write'],
  'package.json': ['prettier --write'],
};
