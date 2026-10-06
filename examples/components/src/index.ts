import { createRegistry } from '@wishyor/zyrox-react';
import { type ExampleActionHandlers, exampleActions } from './actions';
import { exampleManifestInput } from './manifest';
import { webComponents } from './web/components';
import { webMotion } from './web/motion';

export { exampleStrings } from './strings';
export * from './web/components';
export type { ExampleActionHandlers };
export { exampleManifestInput, webMotion };

export function createExampleRegistry(handlers?: ExampleActionHandlers) {
  return createRegistry({
    components: webComponents,
    actions: exampleActions(handlers),
    motion: webMotion,
    transitions: exampleManifestInput.transitions,
    tokens: exampleManifestInput.tokens,
  });
}
