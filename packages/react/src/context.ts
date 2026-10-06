import type {
  DeviceInfo,
  Frame,
  I18n,
  Observer,
  OverlayController,
  RuntimeHost,
  ScreenRuntime,
} from '@wishyor/zyrox-core';
import { createContext, useContext } from 'react';
import type { Registry } from './registry';

/** Things that never change for the provider's lifetime (so nodes don't re-render on updates). */
export interface ZyroxStable {
  registry: Registry;
  /** Delegates to the provider's latest props. */
  host: RuntimeHost;
  i18n: I18n;
  mock: boolean;
  debug: boolean;
  /** Wrap nodes for the dashboard canvas (selection, highlighting). */
  inspect: boolean;
  client?: import('@wishyor/zyrox-core').ZyroxClient;
  /** Documents shipped with the app (the provider's `documents`), by key. */
  bundled(key: string): import('@wishyor/zyrox-protocol').Document | undefined;
  /** Open sheets, alerts and toasts. */
  overlays: OverlayController;
  /** Runs actions outside any screen (your code, your backend, trigger rules). */
  appRuntime: ScreenRuntime;
  /** Adds an observer of every screen's events. */
  observe(observer: Observer): () => void;
  storage(): import('./platform-api').ZyroxStorage | undefined;
  /** Set by `<ZyroxRemote>`: handles backend messages (dedupe, triggers). */
  receiver: { current?: (message: unknown) => Promise<boolean> };
}

export interface ZyroxDynamic {
  app: Record<string, unknown>;
  device: DeviceInfo;
}

export const StableContext = createContext<ZyroxStable | null>(null);
export const DynamicContext = createContext<ZyroxDynamic | null>(null);
export const RuntimeContext = createContext<ScreenRuntime | null>(null);
export const FrameContext = createContext<Frame | null>(null);

export function useZyrox(): ZyroxStable {
  const value = useContext(StableContext);
  if (!value) throw new Error('Wrap your app in <ZyroxProvider>');
  return value;
}

export function useZyroxDynamic(): ZyroxDynamic {
  const value = useContext(DynamicContext);
  if (!value) throw new Error('Wrap your app in <ZyroxProvider>');
  return value;
}

/** The runtime of the screen this component is rendered in. */
export function useScreenRuntime(): ScreenRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Must be rendered inside <ZyroxScreen>');
  return runtime;
}

export function useFrame(): Frame | null {
  return useContext(FrameContext);
}
