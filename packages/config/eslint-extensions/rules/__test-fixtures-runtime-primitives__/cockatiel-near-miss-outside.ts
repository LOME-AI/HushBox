// Fixture: a package whose name merely begins with the same letters is a
// different package, reachable from anywhere. None of these is a finding, in
// any import form.

import { thing } from 'cockatiel-extra';

export * from 'cockatiel-extra/deep.js';

export { other } from 'cockatielx';

export async function loadDynamically(): Promise<unknown> {
  return import('cockatiel-extra');
}

export const reExported = thing;
