import { createServer } from 'node:http';
import { execFile, execSync } from 'node:child_process';
import {
  verificationEmail,
  passwordChangedEmail,
  twoFactorEnabledEmail,
  twoFactorDisabledEmail,
  accountLockedEmail,
} from '../apps/api/src/services/email/templates/index.js';

export const SERVER_ID = Date.now().toString(36);

interface TemplateEntry {
  label: string;
  render: () => string;
}

export const TEMPLATES: Record<string, TemplateEntry> = {
  verification: {
    label: 'Email Verification',
    render: () =>
      verificationEmail({
        verificationUrl: 'https://hushbox.ai/verify?token=sample-token-abc123',
        userName: 'Alice',
        expiresInHours: 24,
      }).html,
  },
  'password-changed': {
    label: 'Password Changed',
    render: () => passwordChangedEmail({ userName: 'Alice' }).html,
  },
  'two-factor-enabled': {
    label: 'Two-Factor Enabled',
    render: () => twoFactorEnabledEmail({ userName: 'Alice' }).html,
  },
  'two-factor-disabled': {
    label: 'Two-Factor Disabled',
    render: () => twoFactorDisabledEmail({ userName: 'Alice' }).html,
  },
  'account-locked': {
    label: 'Account Locked',
    render: () => accountLockedEmail({ userName: 'Alice', lockoutMinutes: 15 }).html,
  },
};

export function renderTemplate(name: string): string | null {
  const entry = TEMPLATES[name];
  if (!entry) return null;
  return entry.render();
}

const RELOAD_SCRIPT = `<script>
  let sid;
  setInterval(async () => {
    try {
      const r = await fetch('/__reload');
      const id = await r.text();
      if (sid && sid !== id) location.reload();
      sid = id;
    } catch {}
  }, 500);
</script>`;

export function generateIndexHtml(): string {
  const iframes = Object.entries(TEMPLATES)
    .map(
      ([name, { label }]) => `
      <div style="margin-bottom: 48px;">
        <h2 style="margin: 0 0 12px 0; color: #fafafa; font-size: 18px; font-weight: 600;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
          ${label}
        </h2>
        <iframe src="/${name}" style="width: 100%; height: 600px; border: 1px solid #27272a; border-radius: 8px; background: #0a0a0a;"></iframe>
      </div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Template Preview</title>
  <style>
    body {
      margin: 0;
      padding: 40px;
      background: #09090b;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    h1 {
      margin: 0 0 32px 0;
      color: #fafafa;
      font-size: 28px;
      font-weight: 700;
    }
    h1 span {
      color: #a1a1aa;
      font-size: 14px;
      font-weight: 400;
    }
  </style>
</head>
<body>
  <h1>Email Template Preview <span>${String(Object.keys(TEMPLATES).length)} templates</span></h1>
  ${iframes}
  ${RELOAD_SCRIPT}
</body>
</html>`;
}

interface RequestResult {
  statusCode: number;
  contentType: string;
  body: string;
}

export function handleRequest(url: string): RequestResult {
  if (url === '/') {
    return { statusCode: 200, contentType: 'text/html', body: generateIndexHtml() };
  }

  if (url === '/__reload') {
    return { statusCode: 200, contentType: 'text/plain', body: SERVER_ID };
  }

  const name = url.slice(1);
  const html = renderTemplate(name);
  if (html) {
    return { statusCode: 200, contentType: 'text/html', body: html };
  }

  return { statusCode: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' };
}

const PORT = 3333;

export function getOpenCommand(): string {
  if (process.platform === 'darwin') return 'open';
  if (process.platform === 'win32') return 'start';
  return 'xdg-open';
}

function killProcessesOnPortWindows(port: number): void {
  // eslint-disable-next-line sonarjs/os-command -- dev-only process management
  const output = execSync(`netstat -ano | findstr :${String(port)} | findstr LISTENING`, {
    encoding: 'utf8',
  }).trim();
  for (const line of output.split('\n')) {
    const pid = Number(line.trim().split(/\s+/).pop());
    if (pid && pid !== process.pid) {
      // eslint-disable-next-line sonarjs/os-command -- dev-only process management
      execSync(`taskkill /PID ${String(pid)} /F`, { stdio: 'ignore' });
    }
  }
}

function killProcessesOnPortUnix(port: number): void {
  // eslint-disable-next-line sonarjs/os-command -- dev-only process management
  const output = execSync(`lsof -ti:${String(port)}`, { encoding: 'utf8' }).trim();
  for (const line of output.split('\n')) {
    const pid = Number(line.trim());
    if (pid && pid !== process.pid) {
      process.kill(pid, 'SIGTERM');
    }
  }
}

function killExistingServer(): void {
  try {
    if (process.platform === 'win32') {
      killProcessesOnPortWindows(PORT);
    } else {
      killProcessesOnPortUnix(PORT);
    }
    console.log('Killed existing server');
  } catch {
    // No process on port — expected
  }
}

export function startServer(): void {
  killExistingServer();

  const server = createServer((req, res) => {
    const result = handleRequest(req.url ?? '/');
    res.writeHead(result.statusCode, { 'Content-Type': result.contentType });
    res.end(result.body);
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${String(PORT)}`;
    console.log(`Email preview server running at ${url}`);
    console.log('Watching for changes (restart with tsx --watch)');
    execFile(getOpenCommand(), [url]);
  });
}

const isMainModule = process.argv[1]?.endsWith('email-preview.ts');
if (isMainModule) {
  startServer();
}
