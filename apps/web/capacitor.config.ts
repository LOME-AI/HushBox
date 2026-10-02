// The subpaths, never the barrel: the Capacitor CLI loads this file as CommonJS, and the
// barrel reaches modules that read `import.meta`, which fails that load.
import { createEnvUtilities } from '@hushbox/shared/env';
import { nativeWebViewServer } from '@hushbox/shared/origins';

import type { CapacitorConfig } from '@capacitor/cli';
import type { NativeWebViewServer } from '@hushbox/shared/origins';

/**
 * WebView remote debugging is a release-time attack convenience, so it is on
 * only for development builds. This file is evaluated by the Capacitor CLI in a
 * plain Node process: `import.meta.env` (the app's usual env-mode source) does
 * not exist here and the CLI passes no mode signal, so the mode is read from
 * `process.env.NODE_ENV` and classified through the shared `createEnvUtilities`
 * detector rather than a raw string compare. NODE_ENV is unset during a bare
 * `cap sync`; that absence resolves to disabled (secure default) — feeding
 * `undefined` to `createEnvUtilities` fail-fasts by design and would break sync.
 */
export function resolveWebContentsDebugging(nodeEnv: string | undefined): boolean {
  if (nodeEnv === undefined) return false;
  return createEnvUtilities({ NODE_ENV: nodeEnv }).isDev;
}

/**
 * Where the WebViews serve the bundle from, which is the origin the API's gates
 * must trust. Read from `process.env.NODE_ENV` for the reason
 * {@link resolveWebContentsDebugging} records; an unset
 * NODE_ENV (a bare `cap sync`, as the release workflows run it) resolves to the
 * production origin, so only a build that states a non-production mode is
 * served from localhost.
 */
export function resolveNativeWebViewServer(nodeEnv: string | undefined): NativeWebViewServer {
  if (nodeEnv === undefined) return nativeWebViewServer(true);
  return nativeWebViewServer(createEnvUtilities({ NODE_ENV: nodeEnv }).isProduction);
}

const config: CapacitorConfig = {
  appId: 'ai.hushbox.app',
  appName: 'HushBox',
  webDir: 'dist',
  server: { ...resolveNativeWebViewServer(process.env['NODE_ENV']) },
  android: {
    webContentsDebuggingEnabled: resolveWebContentsDebugging(process.env['NODE_ENV']),
  },
  plugins: {
    // Each endpoint left unset falls back to the vendor's host, and the stats endpoint
    // reports a reinstall-surviving device id on every app open and close; an empty string
    // is the plugin's only off switch. Bundles come from our own API, never these.
    CapacitorUpdater: {
      autoUpdate: false,
      statsUrl: '',
      channelUrl: '',
      updateUrl: '',
    },
    CapacitorCookies: { enabled: true },
    CapacitorHttp: { enabled: false },
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#000000',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
