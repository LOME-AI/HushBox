// Detect the best inference device available in the current environment.
// Used both by tts-engine (main thread, for the `_detectDeviceForTesting`
// export) and by tts.worker (worker thread, for the actual model load).
//
// Returns 'webgpu' only when an adapter is actually obtainable —
// `'gpu' in navigator` alone is insufficient because some browsers (e.g.
// Chrome on Linux without the unsafe-webgpu flag) expose the API surface
// but fail to produce an adapter at runtime. Capacitor's WKWebView/Android
// WebView don't yet enable WebGPU by default as of 2026, so we force WASM
// there to skip the failed-adapter round-trip.

interface WindowWithCapacitor extends Window {
  Capacitor?: { isNativePlatform?: () => boolean };
}

interface NavigatorGpu {
  requestAdapter: () => Promise<unknown>;
}

function isCapacitorNative(): boolean {
  if (!('window' in globalThis)) return false;
  const cap = (globalThis.window as WindowWithCapacitor).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

function getNavigatorGpu(): NavigatorGpu | undefined {
  if (!('navigator' in globalThis) || !('gpu' in globalThis.navigator)) return undefined;
  return (globalThis.navigator as Navigator & { gpu?: NavigatorGpu }).gpu;
}

export async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (isCapacitorNative()) return 'wasm';
  const gpu = getNavigatorGpu();
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter == null ? 'wasm' : 'webgpu';
  } catch {
    return 'wasm';
  }
}
