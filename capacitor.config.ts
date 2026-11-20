import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.cyberkiwi.client',
  appName: 'CyberKiwi',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  ios: {
    contentInset: 'automatic',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: true,
    preferredContentMode: 'mobile',
  },
  android: {
    allowMixedContent: true,
    backgroundColor: '#0A0F1A',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_cyberkiwi',
      iconColor: '#0D9488',
      sound: 'default',
    },
    Share: {},
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0A0F1A',
      showSpinner: false,
    },
    StatusBar: {
      style: 'dark',
      overlaysWebView: true,
      backgroundColor: '#0A0F1A',
    },
    Keyboard: {
      resize: 'ionic',
      style: 'dark',
    },
  },
};

export default config;
