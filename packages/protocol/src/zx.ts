import { z } from 'zod';

export type Widget = 'image' | 'color' | 'url' | 'multiline';

const hint = (widget: Widget) => z.string().meta({ 'x-zyrox': { widget } });

/**
 * Plain Zod schemas with an editor hint, so the dashboard shows the right input.
 * They don't impose any design system.
 */
export const zx = {
  image: () => hint('image'),
  color: () => hint('color'),
  url: () => hint('url'),
  multiline: () => hint('multiline'),
};
