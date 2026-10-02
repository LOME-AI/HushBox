import { describe, it, expect } from 'vitest';
import {
  configHashOf,
  parseComposeHashes,
  parseComposePs,
  servicesMatchConfig,
} from './compose-state.js';

const HASH_LABEL = 'com.docker.compose.config-hash';

/** The label list a container carries, with the config hash somewhere in it. */
function labels(hash: string, ...others: string[]): string {
  return [...others, HASH_LABEL + '=' + hash].join(',');
}

function psLine(service: string, labelList: string, health = 'healthy', state = 'running'): string {
  return JSON.stringify({ Service: service, Health: health, State: state, Labels: labelList });
}

describe('parseComposePs', () => {
  it('reads the newline-delimited form compose prints a service at a time', () => {
    const stdout = [psLine('redis', labels('aaa')), psLine('minio', labels('bbb'))].join('\n');

    expect(parseComposePs(stdout).map((row) => row.service)).toEqual(['redis', 'minio']);
  });

  it('reads the array form newer compose versions print instead', () => {
    const stdout = '[' + psLine('redis', labels('aaa')) + ']';

    expect(parseComposePs(stdout).map((row) => row.service)).toEqual(['redis']);
  });

  it('reads nothing out of empty output, so a stack that is down is simply absent', () => {
    expect(parseComposePs('   ')).toEqual([]);
  });

  it('fills in a row that names no health, state or labels rather than carrying undefined onward', () => {
    expect(parseComposePs(JSON.stringify({ Service: 'redis' }))).toEqual([
      { service: 'redis', health: '', state: '', configHash: null },
    ]);
  });
});

describe('configHashOf', () => {
  it('picks the compose config hash out of the label list', () => {
    expect(configHashOf(labels('abc123', 'maintainer=someone') + ',version=1')).toBe('abc123');
  });

  it('is not fooled by a label whose value contains commas ahead of it', () => {
    expect(configHashOf(labels('abc123', 'description=one, two, three'))).toBe('abc123');
  });

  it('answers null when the container carries no such label', () => {
    expect(configHashOf('maintainer=someone')).toBeNull();
  });
});

describe('parseComposeHashes', () => {
  it('maps each service to the hash compose computes for it now', () => {
    const hashes = parseComposeHashes('redis c5cc\nminio 277b\n');

    expect(hashes.get('redis')).toBe('c5cc');
    expect(hashes.get('minio')).toBe('277b');
  });

  it('ignores a blank line rather than minting a service named nothing', () => {
    expect([...parseComposeHashes('redis c5cc\n\n').keys()]).toEqual(['redis']);
  });
});

describe('servicesMatchConfig', () => {
  const hashes = new Map([
    ['redis', 'aaa'],
    ['minio', 'bbb'],
  ]);

  it('accepts a service that is up and carrying the hash compose computes today', () => {
    const running = parseComposePs(
      [psLine('redis', labels('aaa')), psLine('minio', labels('bbb'))].join('\n')
    );

    expect(servicesMatchConfig(['redis', 'minio'], running, hashes)).toBe(true);
  });

  it('rejects a healthy service whose hash is stale, because health is not configuration', () => {
    const running = parseComposePs(
      [psLine('redis', labels('stale')), psLine('minio', labels('bbb'))].join('\n')
    );

    expect(servicesMatchConfig(['redis', 'minio'], running, hashes)).toBe(false);
  });

  it('rejects a service that is not running at all', () => {
    const running = parseComposePs(psLine('redis', labels('aaa')));

    expect(servicesMatchConfig(['redis', 'minio'], running, hashes)).toBe(false);
  });

  it('accepts a running service that declares no healthcheck', () => {
    const running = parseComposePs(psLine('redis', labels('aaa'), '', 'running'));

    expect(servicesMatchConfig(['redis'], running, hashes)).toBe(true);
  });

  it('rejects a service that is up but unhealthy', () => {
    const running = parseComposePs(psLine('redis', labels('aaa'), 'unhealthy', 'running'));

    expect(servicesMatchConfig(['redis'], running, hashes)).toBe(false);
  });

  it('rejects a service compose could compute no hash for, so the work is done rather than skipped', () => {
    const running = parseComposePs(psLine('redis', labels('aaa')));

    expect(servicesMatchConfig(['redis'], running, new Map())).toBe(false);
  });

  it('rejects a service whose row names neither health nor state, uncertainty being work to do', () => {
    const running = parseComposePs(JSON.stringify({ Service: 'redis', Labels: labels('aaa') }));

    expect(servicesMatchConfig(['redis'], running, hashes)).toBe(false);
  });

  it('rejects a container carrying no hash label at all', () => {
    const running = parseComposePs(psLine('redis', 'maintainer=someone'));

    expect(servicesMatchConfig(['redis'], running, hashes)).toBe(false);
  });
});
