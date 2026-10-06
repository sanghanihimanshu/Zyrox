import type { DeviceInfo } from '@wishyor/zyrox-core';
import { isRtl } from '@wishyor/zyrox-core';
import { createElement, type ReactNode, useSyncExternalStore } from 'react';
import type { Platform, ZyroxStorage } from './platform-api';

const hasWindow = typeof window !== 'undefined';

function locales(): string[] {
  if (typeof navigator === 'undefined') return ['en'];
  return [...(navigator.languages ?? []), navigator.language].filter(Boolean);
}

function readDevice(): DeviceInfo {
  const locale = locales()[0] ?? 'en';
  if (!hasWindow)
    return {
      platform: 'web',
      width: 0,
      height: 0,
      colorScheme: 'light',
      locale,
      direction: isRtl(locale) ? 'rtl' : 'ltr',
    };
  const dark =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    platform: 'web',
    width: window.innerWidth,
    height: window.innerHeight,
    colorScheme: dark ? 'dark' : 'light',
    locale,
    direction: isRtl(locale) ? 'rtl' : 'ltr',
  };
}

let snapshot: DeviceInfo | undefined;
const SERVER_DEVICE = readDevice();

function getSnapshot(): DeviceInfo {
  const next = readDevice();
  if (
    !snapshot ||
    snapshot.width !== next.width ||
    snapshot.height !== next.height ||
    snapshot.colorScheme !== next.colorScheme ||
    snapshot.locale !== next.locale
  ) {
    snapshot = next;
  }
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  if (!hasWindow) return () => {};
  window.addEventListener('resize', listener);
  window.addEventListener('languagechange', listener);
  const media =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
  media?.addEventListener?.('change', listener);
  return () => {
    window.removeEventListener('resize', listener);
    window.removeEventListener('languagechange', listener);
    media?.removeEventListener?.('change', listener);
  };
}

/** `display: contents` keeps layout untouched while letting clicks and rects map back to nodes. */
function Inspect({ nodeId, children }: { nodeId: string; children?: ReactNode }) {
  return createElement('span', { 'data-zyrox-node': nodeId, style: { display: 'contents' } }, children);
}

export const webPlatform: Platform = {
  name: 'web',
  Inspect,
  useDevice: () => useSyncExternalStore(subscribe, getSnapshot, () => SERVER_DEVICE),
  openUrl: (url) => {
    if (hasWindow) window.open(url, '_blank', 'noopener,noreferrer');
  },
  onForeground: (listener) => {
    if (typeof document === 'undefined') return () => {};
    const handler = () => {
      if (document.visibilityState === 'visible') listener();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  onBackground: (listener) => {
    if (typeof document === 'undefined') return () => {};
    const handler = () => {
      if (document.visibilityState === 'hidden') listener();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  },
  preferredLocales: locales,
  defaultStorage: (): ZyroxStorage | undefined => {
    try {
      return hasWindow && window.localStorage ? window.localStorage : undefined;
    } catch {
      return undefined;
    }
  },
};
