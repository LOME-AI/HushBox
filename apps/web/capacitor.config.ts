import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.hushbox.app',
  appName: 'HushBox',
  webDir: 'dist',
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
