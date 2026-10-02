/** Where the native WebViews serve the app bundle from: the `server` block of the Capacitor config. */
export interface NativeWebViewServer {
  readonly hostname: string;
  readonly androidScheme: 'http' | 'https';
}

/**
 * Production serves from `native.hushbox.ai`, a hushbox.ai name never published
 * in DNS: only HushBox can create a record or obtain a certificate for it, so no
 * page a desktop browser loads can carry the app's origin. Every other mode keeps
 * `http://localhost`, because under schemeful same-site the development
 * `SameSite=Lax` cookie only flows between the WebView and an `http://localhost`
 * API.
 */
export function nativeWebViewServer(isProduction: boolean): NativeWebViewServer {
  return isProduction
    ? { hostname: 'native.hushbox.ai', androidScheme: 'https' }
    : { hostname: 'localhost', androidScheme: 'http' };
}

/**
 * The mobile app shell's WebView origins for a mode: iOS serves the bundle from
 * `capacitor://<hostname>`, Android from `<androidScheme>://<hostname>`. Every
 * origin gate the native app passes must admit both, and only for the mode the
 * gate runs in.
 */
export function capacitorOrigins(isProduction: boolean): readonly [ios: string, android: string] {
  const { hostname, androidScheme } = nativeWebViewServer(isProduction);
  return [`capacitor://${hostname}`, `${androidScheme}://${hostname}`];
}
