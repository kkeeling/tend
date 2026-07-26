import { GlobalRegistrator } from "@happy-dom/global-registrator";

const runtimeGlobalNames = [
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "FormData",
  "Headers",
  "ReadableStream",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "WritableStream",
  "crypto",
  "fetch",
  "performance",
  "structuredClone",
] as const;

const runtimeGlobals = new Map<PropertyKey, PropertyDescriptor>();
for (const name of runtimeGlobalNames) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor) runtimeGlobals.set(name, descriptor);
}

export function registerHappyDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

  // Component tests need Happy DOM's document model, not its replacement
  // network and stream APIs. Keep Bun's native service primitives available
  // to unrelated tests sharing this process.
  for (const [name, descriptor] of runtimeGlobals) {
    Object.defineProperty(globalThis, name, descriptor);
  }
}
