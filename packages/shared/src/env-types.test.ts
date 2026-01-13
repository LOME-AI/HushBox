import { describe, it, expect } from 'vitest';
import {
  Dest,
  Mode,
  ref,
  secret,
  isRef,
  isSecret,
  isModeOverride,
  getDestinations,
  getModeValue,
  resolveRaw,
  resolveValue,
  isProductionSecret,
  type VarConfig,
} from './env-types.js';

describe('env-types', () => {
  describe('Dest enum', () => {
    it('has three destinations', () => {
      expect(Dest.Backend).toBe('backend');
      expect(Dest.Frontend).toBe('frontend');
      expect(Dest.Scripts).toBe('scripts');
    });
  });

  describe('Mode enum', () => {
    it('has four modes', () => {
      expect(Mode.Development).toBe('development');
      expect(Mode.CiVitest).toBe('ciVitest');
      expect(Mode.CiE2E).toBe('ciE2E');
      expect(Mode.Production).toBe('production');
    });
  });

  describe('ref helper', () => {
    it('creates a ref object', () => {
      const result = ref(Mode.Development);
      expect(result).toEqual({ _type: 'ref', env: Mode.Development });
    });

    it('works with all modes', () => {
      expect(ref(Mode.CiVitest)).toEqual({ _type: 'ref', env: Mode.CiVitest });
      expect(ref(Mode.CiE2E)).toEqual({ _type: 'ref', env: Mode.CiE2E });
      expect(ref(Mode.Production)).toEqual({ _type: 'ref', env: Mode.Production });
    });
  });

  describe('secret helper', () => {
    it('creates a secret object', () => {
      const result = secret('DATABASE_URL');
      expect(result).toEqual({ _type: 'secret', name: 'DATABASE_URL' });
    });
  });

  describe('isRef type guard', () => {
    it('returns true for ref objects', () => {
      expect(isRef(ref(Mode.Development))).toBe(true);
    });

    it('returns false for secret objects', () => {
      expect(isRef(secret('TEST'))).toBe(false);
    });

    it('returns false for strings', () => {
      expect(isRef('literal-value')).toBe(false);
    });
  });

  describe('isSecret type guard', () => {
    it('returns true for secret objects', () => {
      expect(isSecret(secret('DATABASE_URL'))).toBe(true);
    });

    it('returns false for ref objects', () => {
      expect(isSecret(ref(Mode.Development))).toBe(false);
    });

    it('returns false for strings', () => {
      expect(isSecret('literal-value')).toBe(false);
    });
  });

  describe('isModeOverride type guard', () => {
    it('returns true for override objects', () => {
      expect(isModeOverride({ value: 'test', to: [Dest.Backend] })).toBe(true);
    });

    it('returns false for strings', () => {
      expect(isModeOverride('literal-value')).toBe(false);
    });

    it('returns false for ref objects', () => {
      expect(isModeOverride(ref(Mode.Development))).toBe(false);
    });

    it('returns false for secret objects', () => {
      expect(isModeOverride(secret('TEST'))).toBe(false);
    });
  });

  describe('getDestinations', () => {
    it('returns default destinations when mode has simple value', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'value',
      };
      expect(getDestinations(config, Mode.Development)).toEqual([Dest.Backend]);
    });

    it('returns override destinations when mode has override', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: { value: 'value', to: [Dest.Backend, Dest.Scripts] },
      };
      expect(getDestinations(config, Mode.Development)).toEqual([Dest.Backend, Dest.Scripts]);
    });

    it('returns empty array when mode is not set', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'value',
      };
      expect(getDestinations(config, Mode.Production)).toEqual([]);
    });
  });

  describe('getModeValue', () => {
    it('returns string value directly', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'literal-value',
      };
      expect(getModeValue(config, Mode.Development)).toBe('literal-value');
    });

    it('returns ref object directly', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.CiVitest]: ref(Mode.Development),
      };
      expect(getModeValue(config, Mode.CiVitest)).toEqual(ref(Mode.Development));
    });

    it('returns secret object directly', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Production]: secret('DATABASE_URL'),
      };
      expect(getModeValue(config, Mode.Production)).toEqual(secret('DATABASE_URL'));
    });

    it('unwraps override object to get value', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: { value: 'wrapped-value', to: [Dest.Backend, Dest.Scripts] },
      };
      expect(getModeValue(config, Mode.Development)).toBe('wrapped-value');
    });

    it('returns undefined when mode is not set', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'value',
      };
      expect(getModeValue(config, Mode.Production)).toBeUndefined();
    });
  });

  describe('resolveRaw', () => {
    it('returns literal value directly', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'literal-value',
      };
      expect(resolveRaw(config, Mode.Development)).toBe('literal-value');
    });

    it('follows ref to get value', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.CiVitest]: ref(Mode.Development),
      };
      expect(resolveRaw(config, Mode.CiVitest)).toBe('dev-value');
    });

    it('follows chained refs', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.CiVitest]: ref(Mode.Development),
        [Mode.CiE2E]: ref(Mode.CiVitest),
      };
      expect(resolveRaw(config, Mode.CiE2E)).toBe('dev-value');
    });

    it('returns secret object when resolved', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.CiVitest]: secret('API_KEY'),
        [Mode.Production]: ref(Mode.CiVitest),
      };
      expect(resolveRaw(config, Mode.Production)).toEqual(secret('API_KEY'));
    });

    it('unwraps override before following ref', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.CiVitest]: { value: ref(Mode.Development), to: [Dest.Backend] },
      };
      expect(resolveRaw(config, Mode.CiVitest)).toBe('dev-value');
    });

    it('returns undefined for unset mode', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
      };
      expect(resolveRaw(config, Mode.Production)).toBeUndefined();
    });
  });

  describe('resolveValue', () => {
    const mockGetSecret = (name: string): string => {
      const secrets: Record<string, string> = {
        DATABASE_URL: 'postgres://prod',
        API_KEY: 'secret-api-key',
      };
      const value = secrets[name];
      if (!value) throw new Error(`Missing secret: ${name}`);
      return value;
    };

    it('returns literal value directly', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'literal-value',
      };
      expect(resolveValue(config, Mode.Development, mockGetSecret)).toBe('literal-value');
    });

    it('follows ref and returns value', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.CiVitest]: ref(Mode.Development),
      };
      expect(resolveValue(config, Mode.CiVitest, mockGetSecret)).toBe('dev-value');
    });

    it('resolves secret using getSecret callback', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Production]: secret('DATABASE_URL'),
      };
      expect(resolveValue(config, Mode.Production, mockGetSecret)).toBe('postgres://prod');
    });

    it('follows ref to secret and resolves', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.CiVitest]: secret('API_KEY'),
        [Mode.Production]: ref(Mode.CiVitest),
      };
      expect(resolveValue(config, Mode.Production, mockGetSecret)).toBe('secret-api-key');
    });

    it('returns null for unset mode', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
      };
      expect(resolveValue(config, Mode.Production, mockGetSecret)).toBeNull();
    });

    it('throws when secret is missing', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Production]: secret('MISSING_SECRET'),
      };
      expect(() => resolveValue(config, Mode.Production, mockGetSecret)).toThrow(
        'Missing secret: MISSING_SECRET'
      );
    });
  });

  describe('isProductionSecret', () => {
    it('returns true when production value is a secret', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.Production]: secret('DATABASE_URL'),
      };
      expect(isProductionSecret(config)).toBe(true);
    });

    it('returns true when production refs to a secret', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.CiVitest]: secret('API_KEY'),
        [Mode.Production]: ref(Mode.CiVitest),
      };
      expect(isProductionSecret(config)).toBe(true);
    });

    it('returns false when production value is literal', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.Production]: 'prod-value',
      };
      expect(isProductionSecret(config)).toBe(false);
    });

    it('returns false when production is not set', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
      };
      expect(isProductionSecret(config)).toBe(false);
    });

    it('returns false when production refs to a literal', () => {
      const config: VarConfig = {
        to: [Dest.Backend],
        [Mode.Development]: 'dev-value',
        [Mode.Production]: ref(Mode.Development),
      };
      expect(isProductionSecret(config)).toBe(false);
    });
  });
});
