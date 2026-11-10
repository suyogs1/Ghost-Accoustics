import type { GgwaveModule } from '@ghost-acoustics/core';

type GlobalFactory = () => Promise<GgwaveModule>;

let modulePromise: Promise<GgwaveModule> | null = null;

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Loads the vendored ggwave WASM build (public/vendor/ggwave.js, served locally so the
 * app works with no internet) once and shares the module between channels.
 */
export function loadGgwave(): Promise<GgwaveModule> {
  modulePromise ??= (async () => {
    const existing = (globalThis as { ggwave_factory?: GlobalFactory }).ggwave_factory;
    if (!existing) await injectScript(`${import.meta.env.BASE_URL}vendor/ggwave.js`);
    const factory = (globalThis as { ggwave_factory?: GlobalFactory }).ggwave_factory;
    if (!factory) throw new Error('ggwave failed to initialise');
    return factory();
  })().catch((err: unknown) => {
    modulePromise = null; // allow a retry after a transient failure
    throw err;
  });
  return modulePromise;
}
