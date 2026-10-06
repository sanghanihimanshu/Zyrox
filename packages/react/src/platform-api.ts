import type { DeviceInfo } from '@zyrox/core';
import type { ComponentType, ReactNode } from 'react';

/** Key-value storage. Works with `localStorage`, AsyncStorage, MMKV (wrap `getString`/`set`)… */
export interface ZyroxStorage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Platform services, provided by `index.ts` (web) or `index.native.ts` (React Native). */
export interface Platform {
  name: string;
  useDevice(): DeviceInfo;
  openUrl(url: string): unknown;
  onForeground(listener: () => void): () => void;
  /** The app went to the background (flush telemetry, persist state). */
  onBackground(listener: () => void): () => void;
  preferredLocales(): string[];
  defaultStorage(): ZyroxStorage | undefined;
  /** Marks a node's output so the dashboard canvas can select and highlight it. */
  Inspect: ComponentType<{ nodeId: string; children?: ReactNode }>;
}

let current: Platform | undefined;

export function setPlatform(platform: Platform): void {
  current = platform;
}

export function getPlatform(): Platform {
  if (!current)
    throw new Error('@zyrox/react: no platform set. Import from "@zyrox/react", not from its internals.');
  return current;
}
