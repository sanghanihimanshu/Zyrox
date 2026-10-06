import type { ManifestInput } from '@wishyor/zyrox-protocol';
import { actionDefs, componentDefs } from './defs';
import { palette, space, textSize } from './tokens';

/** What the example apps support. Used by the registries and by `zyrox.config.ts` (CLI). */
export const exampleManifestInput: ManifestInput = {
  components: componentDefs,
  actions: actionDefs,
  motions: ['fade', 'slideUp', 'scale'],
  transitions: ['slide', 'fade'],
  tokens: { color: { ...palette.light }, space: { ...space }, textSize: { ...textSize } },
};
