import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.hushbox.app',
  appName: 'HushBox',
  webDir: 'dist',
  server: {
    // Use http scheme so the WebView origin (http://localhost) is same-site with
    // the dev API (http://localhost:PORT). SameSite=lax cookies require same-site.
    // Production uses SameSite=none;Secure=true so the scheme doesn't matter.
    androidScheme: 'http',
  },
  android: {
    webContentsDebuggingEnabled: true,
  },
  plugins: {
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
