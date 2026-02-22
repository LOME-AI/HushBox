import { describe, it, expect } from 'vitest';
import {
  TEMPLATES,
  renderTemplate,
  generateIndexHtml,
  handleRequest,
  SERVER_ID,
  getOpenCommand,
} from './email-preview.js';

describe('email-preview', () => {
  describe('TEMPLATES', () => {
    it('defines all 5 email templates', () => {
      const names = Object.keys(TEMPLATES);
      expect(names).toEqual([
        'verification',
        'password-changed',
        'two-factor-enabled',
        'two-factor-disabled',
        'account-locked',
      ]);
    });

    it('each template has a label and render function', () => {
      for (const [, template] of Object.entries(TEMPLATES)) {
        expect(template).toHaveProperty('label');
        expect(template).toHaveProperty('render');
        expect(typeof template.label).toBe('string');
        expect(typeof template.render).toBe('function');
      }
    });
  });

  describe('SERVER_ID', () => {
    it('is a non-empty string', () => {
      expect(typeof SERVER_ID).toBe('string');
      expect(SERVER_ID.length).toBeGreaterThan(0);
    });
  });

  describe('getOpenCommand', () => {
    it('returns a known browser open command for the current platform', () => {
      const cmd = getOpenCommand();
      expect(['open', 'start', 'xdg-open']).toContain(cmd);
    });
  });

  describe('renderTemplate', () => {
    it('renders verification email as valid HTML', () => {
      const html = renderTemplate('verification');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Hush');
      expect(html).toContain('Box');
      expect(html).toContain('Verify Email');
    });

    it('renders password-changed email', () => {
      const html = renderTemplate('password-changed');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Password Changed');
    });

    it('renders two-factor-enabled email', () => {
      const html = renderTemplate('two-factor-enabled');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Two-Factor');
    });

    it('renders two-factor-disabled email', () => {
      const html = renderTemplate('two-factor-disabled');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Two-Factor');
    });

    it('renders account-locked email', () => {
      const html = renderTemplate('account-locked');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Account Temporarily Locked');
    });

    it('returns null for unknown template name', () => {
      const html = renderTemplate('nonexistent');
      expect(html).toBeNull();
    });
  });

  describe('generateIndexHtml', () => {
    it('contains iframe for each template', () => {
      const html = generateIndexHtml();
      for (const name of Object.keys(TEMPLATES)) {
        expect(html).toContain(`src="/${name}"`);
      }
    });

    it('contains label for each template', () => {
      const html = generateIndexHtml();
      for (const [, template] of Object.entries(TEMPLATES)) {
        expect(html).toContain(template.label);
      }
    });

    it('is a complete HTML document', () => {
      const html = generateIndexHtml();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Email Template Preview');
    });

    it('contains live-reload script polling __reload endpoint', () => {
      const html = generateIndexHtml();
      expect(html).toContain('__reload');
      expect(html).toContain('location.reload');
    });
  });

  describe('handleRequest', () => {
    it('returns index page for root path', () => {
      const result = handleRequest('/');
      expect(result.statusCode).toBe(200);
      expect(result.contentType).toBe('text/html');
      expect(result.body).toContain('Email Template Preview');
    });

    it('returns rendered template for valid template path', () => {
      const result = handleRequest('/verification');
      expect(result.statusCode).toBe(200);
      expect(result.contentType).toBe('text/html');
      expect(result.body).toContain('Verify Email');
    });

    it('returns 404 for unknown path', () => {
      const result = handleRequest('/unknown');
      expect(result.statusCode).toBe(404);
      expect(result.body).toContain('Not Found');
    });

    it('handles each template route', () => {
      for (const name of Object.keys(TEMPLATES)) {
        const result = handleRequest(`/${name}`);
        expect(result.statusCode).toBe(200);
        expect(result.contentType).toBe('text/html');
        expect(result.body).toContain('<!DOCTYPE html>');
      }
    });

    it('returns server ID for __reload endpoint', () => {
      const result = handleRequest('/__reload');
      expect(result.statusCode).toBe(200);
      expect(result.contentType).toBe('text/plain');
      expect(result.body).toBe(SERVER_ID);
    });
  });
});
