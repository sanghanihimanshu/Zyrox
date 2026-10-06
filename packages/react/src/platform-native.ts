import type { DeviceInfo } from '@wishyor/zyrox-core';
import { isRtl } from '@wishyor/zyrox-core';
import { createElement, Fragment, type ReactNode, useMemo } from 'react';
import { AppState, Linking, Platform as RNPlatform, useColorScheme, useWindowDimensions } from 'react-native';
import type { Platform } from './platform-api';

function locales(): string[] {
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale];
  } catch {
    return ['en'];
  }
}

function Inspect({ children }: { nodeId: string; children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

export const nativePlatform: Platform = {
  name: RNPlatform.OS,
  Inspect,
  useDevice: (): DeviceInfo => {
    const { width, height } = useWindowDimensions();
    const scheme = useColorScheme();
    return useMemo(() => {
      const locale = locales()[0] ?? 'en';
      return {
        platform: RNPlatform.OS,
        width,
        height,
        colorScheme: scheme === 'dark' ? 'dark' : 'light',
        locale,
        direction: isRtl(locale) ? 'rtl' : 'ltr',
      };
    }, [width, height, scheme]);
  },
  openUrl: (url) => Linking.openURL(url),
  onForeground: (listener) => {
    let last = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      if (last !== 'active' && next === 'active') listener();
      last = next;
    });
    return () => sub.remove();
  },
  onBackground: (listener) => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') listener();
    });
    return () => sub.remove();
  },
  preferredLocales: locales,
  // React Native has no built-in synchronous storage; pass `storage` (MMKV, AsyncStorage) to the provider.
  defaultStorage: () => undefined,
};
