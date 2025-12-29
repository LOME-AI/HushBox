import { exec } from 'child_process';
import type { EmailClient, EmailOptions } from './types.js';

export function createConsoleEmailClient(): EmailClient {
  return {
    sendEmail(options: EmailOptions): Promise<void> {
      console.log('=== Email Sent ===');
      console.log(`To: ${options.to}`);
      console.log(`Subject: ${options.subject}`);
      if (options.from) {
        console.log(`From: ${options.from}`);
      }
      console.log('--- HTML Content ---');
      console.log(options.html);
      console.log('==================');

      const urlMatch = /href="([^"]*verify-email[^"]*)"/.exec(options.html);
      if (urlMatch?.[1]) {
        const url = urlMatch[1];
        console.log(`\n🔗 Opening verification link in browser...`);
        const cmd =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'start'
              : 'xdg-open';
        exec(`${cmd} "${url}"`);
      }

      return Promise.resolve();
    },
  };
}
