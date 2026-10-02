/**
 * Browser-matrix lint extension: every E2E spec declares the two properties its
 * project set is derived from.
 *
 * The plane projects come from the project registry itself rather than a list
 * kept here: the `engine-fixed` arm is only sound while the registry's plane set
 * is what it was derived from, so a copy of that set living here would be free
 * to drift from the thing it claims to describe, which is the whole failure the
 * arm's rung exists to prevent.
 *
 * That registry is TypeScript, so this file is the one extension whose load
 * depends on Node's type stripping. The import is guarded rather than static
 * because every package's config reaches this file through the shared base
 * config: unguarded, a developer on the wrong Node loses lint in packages that
 * have nothing to do with E2E, and reads a module-loader stack that never
 * mentions Node. The catch is a dynamic import's only way to say so.
 */
import matrixDeclaration from './rules/matrix-declaration.mjs';

/** Where type stripping became the default, and so the floor this import needs. */
const TYPE_STRIPPING_NODE_VERSION = '22.18';

// An absolute URL rather than a relative specifier: a dynamic import's
// specifier is a runtime value, which module graphs that rewrite imports
// resolve against their own root instead of this file.
const REGISTRY = new URL('../../../scripts/lib/playwright/projects.ts', import.meta.url).href;

const strippingDisabledBy = () =>
  [...process.execArgv, process.env['NODE_OPTIONS'] ?? ''].some((argument) =>
    argument.includes('no-experimental-strip-types')
  )
    ? ' with --no-experimental-strip-types set, which turns type stripping off'
    : '';

async function planeProjects() {
  try {
    const registry = await import(REGISTRY);
    return registry.PLANE_PROJECTS;
  } catch (error) {
    throw new Error(
      `ESLint cannot read the E2E project registry (scripts/lib/playwright/projects.ts). ` +
        `The browser-matrix extension imports it as TypeScript, which needs Node's type stripping. ` +
        `Required: Node ${TYPE_STRIPPING_NODE_VERSION} or newer, where type stripping is on by default. ` +
        `Running: Node ${process.version}${strippingDisabledBy()}. ` +
        `Do this: run lint on Node ${TYPE_STRIPPING_NODE_VERSION} or newer and do not pass --no-experimental-strip-types. ` +
        `The registry is read rather than copied because the engine-fixed matrix arm is only sound while the plane set is the one it was derived from.`,
      { cause: error }
    );
  }
}

const PLANE_PROJECTS = await planeProjects();

const browserMatrixPlugin = {
  meta: { name: 'browser-matrix', version: '1.0.0' },
  rules: {
    'matrix-declaration': matrixDeclaration,
  },
};

/** @satisfies {import('eslint').Linter.Config[]} */
export default [
  {
    name: 'browser-matrix/matrix-declaration',
    files: ['**/*.spec.ts'],
    plugins: { 'browser-matrix': browserMatrixPlugin },
    rules: {
      'browser-matrix/matrix-declaration': ['error', { planes: PLANE_PROJECTS }],
    },
  },
];
