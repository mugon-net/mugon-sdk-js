// Injected from package.json by vite (vite.config.ts / vite.iife.config.ts) as one string
// literal, so it stays contiguous in every bundle: `mugon publish` scans a game's dist for
// "mugon-sdk-version:" to learn which SDK major was bundled.
declare const __SDK_VERSION_MARKER__: string;

const marker = __SDK_VERSION_MARKER__;

export const version = marker.slice(marker.indexOf(":") + 1);

export function majorOf(sdkVersion: string): number {
  return Number.parseInt(sdkVersion.split(".")[0], 10);
}

export const major = majorOf(version);
