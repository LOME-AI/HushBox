import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILD_IDENTITY_FILE,
  checkBuildIdentity,
  main,
  readBuildIdentity,
  stampBuildIdentity,
} from './stamp-build-identity.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'stamp-build-identity-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A dist directory under the scratch root. */
function bundle(name: string): string {
  const directory = path.join(root, name);
  mkdirSync(directory);
  return directory;
}

const stamped = (directory: string): string =>
  readFileSync(path.join(directory, BUILD_IDENTITY_FILE), 'utf8');

describe('stampBuildIdentity', () => {
  it('writes the version as the exact JSON a probe reads', () => {
    const web = bundle('web');

    stampBuildIdentity(web, '1.2.3');

    expect(stamped(web)).toBe('{"version":"1.2.3"}');
  });

  it('refuses an empty version, writing nothing', () => {
    const web = bundle('web');

    expect(() => {
      stampBuildIdentity(web, '');
    }).toThrow(/version/i);
    expect(() => stamped(web)).toThrow(/ENOENT/);
  });
});

describe('readBuildIdentity', () => {
  it('reads the version out of a stamp', () => {
    expect(readBuildIdentity('{"version":"1.2.3"}')).toBe('1.2.3');
  });

  it('refuses text that is not JSON, which is what a fallback page answers with', () => {
    expect(() => readBuildIdentity('<!doctype html><html></html>')).toThrow(/not JSON/);
  });

  it('refuses JSON of another shape', () => {
    expect(() => readBuildIdentity('{"release":"1.2.3"}')).toThrow(/shape/);
  });

  it('refuses a stamp carrying an empty version', () => {
    expect(() => readBuildIdentity('{"version":""}')).toThrow(/shape/);
  });
});

describe('checkBuildIdentity', () => {
  it('accepts a dist stamped with the version', () => {
    const web = bundle('web');
    stampBuildIdentity(web, '1.2.3');

    expect(() => {
      checkBuildIdentity(web, '1.2.3');
    }).not.toThrow();
  });

  it('refuses a dist stamped with another version, naming both', () => {
    const web = bundle('web');
    stampBuildIdentity(web, '1.2.2');

    expect(() => {
      checkBuildIdentity(web, '1.2.3');
    }).toThrow(/1\.2\.2.*1\.2\.3/);
  });

  it('refuses a dist carrying no stamp', () => {
    const web = bundle('web');

    expect(() => {
      checkBuildIdentity(web, '1.2.3');
    }).toThrow(/ENOENT/);
  });
});

describe('main', () => {
  it('stamps every dist it is named', () => {
    const web = bundle('web');
    const admin = bundle('admin');

    main(['stamp', web, admin], { VERSION: '1.2.3' });

    expect([stamped(web), stamped(admin)]).toEqual(['{"version":"1.2.3"}', '{"version":"1.2.3"}']);
  });

  it('checks every dist it is named, refusing at the first one that differs', () => {
    const web = bundle('web');
    const admin = bundle('admin');
    stampBuildIdentity(web, '1.2.3');
    writeFileSync(path.join(admin, BUILD_IDENTITY_FILE), '{"version":"1.2.2"}');

    expect(() => {
      main(['check', web, admin], { VERSION: '1.2.3' });
    }).toThrow(/admin/);
  });

  it('passes a check of dists that all carry the version', () => {
    const web = bundle('web');
    stampBuildIdentity(web, '1.2.3');

    expect(() => {
      main(['check', web], { VERSION: '1.2.3' });
    }).not.toThrow();
  });

  it('refuses to run without a version', () => {
    expect(() => {
      main(['stamp', bundle('web')], {});
    }).toThrow(/VERSION is required/);
  });

  it('refuses a mode it does not know', () => {
    expect(() => {
      main(['--stamp', bundle('web')], { VERSION: '1.2.3' });
    }).toThrow(/stamp|check/);
  });

  it('refuses a line naming no dist', () => {
    expect(() => {
      main(['stamp'], { VERSION: '1.2.3' });
    }).toThrow(/dist/);
  });

  it('refuses a flag where a dist belongs', () => {
    expect(() => {
      main(['stamp', '--all'], { VERSION: '1.2.3' });
    }).toThrow(/--all/);
  });
});
