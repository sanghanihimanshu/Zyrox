import { useZyroxDynamic } from './context';

/** Colors and shape of the default overlays. */
export interface OverlayTheme {
  background: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  primaryText: string;
  danger: string;
  backdrop: string;
  /** Toast backgrounds by tone (text is white). */
  tones: { info: string; success: string; warning: string; danger: string };
  radius: number;
  fontFamily?: string;
}

export interface OverlayThemeInput {
  light?: Partial<OverlayTheme>;
  dark?: Partial<OverlayTheme>;
}

const light: OverlayTheme = {
  background: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  primary: '#111827',
  primaryText: '#ffffff',
  danger: '#dc2626',
  backdrop: 'rgba(0,0,0,0.45)',
  tones: { info: '#1f2937', success: '#15803d', warning: '#b45309', danger: '#b91c1c' },
  radius: 16,
};

const dark: OverlayTheme = {
  ...light,
  background: '#1c1c1e',
  text: '#f9fafb',
  muted: '#9ca3af',
  border: '#374151',
  primary: '#f9fafb',
  primaryText: '#111827',
  danger: '#f87171',
  backdrop: 'rgba(0,0,0,0.6)',
  tones: { info: '#374151', success: '#166534', warning: '#92400e', danger: '#991b1b' },
};

export function themeHook(input: OverlayThemeInput = {}): () => OverlayTheme {
  const themes = {
    light: { ...light, ...input.light, tones: { ...light.tones, ...input.light?.tones } },
    dark: { ...dark, ...input.dark, tones: { ...dark.tones, ...input.dark?.tones } },
  };
  return () => themes[useZyroxDynamic().device.colorScheme === 'dark' ? 'dark' : 'light'];
}
