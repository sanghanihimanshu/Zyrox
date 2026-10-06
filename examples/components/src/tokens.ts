/** Example design tokens. Your design system replaces all of this. */
export const space = { none: 0, xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export type Space = keyof typeof space;

export const palette = {
  light: {
    bg: '#ffffff',
    surface: '#f4f5f7',
    border: '#e2e4e9',
    text: '#14161a',
    muted: '#6b7280',
    primary: '#4f46e5',
    onPrimary: '#ffffff',
    danger: '#dc2626',
    success: '#16a34a',
  },
  dark: {
    bg: '#0f1115',
    surface: '#1a1d23',
    border: '#2a2e36',
    text: '#f3f4f6',
    muted: '#9ca3af',
    primary: '#818cf8',
    onPrimary: '#0f1115',
    danger: '#f87171',
    success: '#4ade80',
  },
} as const;
export type Scheme = keyof typeof palette;
export type Tone = 'default' | 'muted' | 'primary' | 'danger' | 'success';

export function toneColor(scheme: Scheme, tone: Tone): string {
  const p = palette[scheme];
  return tone === 'default' ? p.text : p[tone];
}

export const textSize = { title: 24, subtitle: 18, body: 16, caption: 13 } as const;
export const textWeight = { title: '700', subtitle: '600', body: '400', caption: '400' } as const;
