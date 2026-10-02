import { describe, it, expect } from 'vitest';
import {
  EMAIL_LEGAL_OWNER,
  QUESTIONS_CONTACT_EMAIL,
  SECURITY_CONTACT_EMAIL,
  SECURITY_TEAM_ACTION,
  greeting,
} from './common.js';

/** How a template reaches the greeting: an optional name read off its parsed params. */
const unnamed: { readonly userName?: string } = {};

describe('greeting', () => {
  it('greets a named user by name', () => {
    expect(greeting('Alice')).toEqual({ kind: 'paragraph', content: ['Hi Alice,'] });
  });

  it('greets without a name when none is given', () => {
    expect(greeting(unnamed.userName)).toEqual({ kind: 'paragraph', content: ['Hi,'] });
  });

  it('greets without a name when the name is empty', () => {
    expect(greeting('')).toEqual({ kind: 'paragraph', content: ['Hi,'] });
  });

  it('never writes "undefined" into the greeting', () => {
    expect(JSON.stringify(greeting(unnamed.userName))).not.toContain('undefined');
  });
});

describe('the security team action', () => {
  it('is labelled "Email the security team"', () => {
    expect(SECURITY_TEAM_ACTION.label).toBe('Email the security team');
  });

  it('writes to the security address', () => {
    expect(SECURITY_TEAM_ACTION).toEqual({
      kind: 'mail',
      label: 'Email the security team',
      address: 'security@hushbox.ai',
    });
  });
});

describe('the contact constants', () => {
  it('names the security address', () => {
    expect(SECURITY_CONTACT_EMAIL).toBe('security@hushbox.ai');
  });

  it('names the questions address', () => {
    expect(QUESTIONS_CONTACT_EMAIL).toBe('hello@hushbox.ai');
  });

  it('names the legal owner', () => {
    expect(EMAIL_LEGAL_OWNER).toBe('LOME-AI LLC');
  });
});
