import { describe, it, expect } from 'vitest';
import { welcomeEmail } from './welcome.js';

describe('welcomeEmail', () => {
  describe('html output', () => {
    it('contains the welcome title', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('Welcome to HushBox');
    });

    it('contains user name when provided', () => {
      const result = welcomeEmail({ userName: 'Alice' });

      expect(result.html).toContain('Alice');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = welcomeEmail({});

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('explains pay-as-you-go billing', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('pay-as-you-go');
    });

    it('contains transparent fee breakdown', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('15%');
      expect(result.html).toContain('5%');
      expect(result.html).toContain('4.5%');
      expect(result.html).toContain('5.5%');
    });

    it('explains how to add credits', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('Billing');
      expect(result.html).toContain('credits');
    });

    it('contains mobile app billing note', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('Manage Balance Online');
    });

    it('contains the footer with copyright', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('uses dark mode styling', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('HTML-escapes user name', () => {
      const result = welcomeEmail({ userName: '<script>alert("xss")</script>' });

      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).not.toContain('<script>alert');
    });
  });

  describe('text output', () => {
    it('contains the welcome title', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('Welcome to HushBox');
    });

    it('contains user name when provided', () => {
      const result = welcomeEmail({ userName: 'Alice' });

      expect(result.text).toContain('Alice');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = welcomeEmail({});

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('explains pay-as-you-go billing', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('pay-as-you-go');
    });

    it('contains transparent fee breakdown', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('15%');
    });

    it('contains mobile app billing note', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('Manage Balance Online');
    });

    it('contains footer with copyright', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('LOME-AI LLC');
    });
  });
});
