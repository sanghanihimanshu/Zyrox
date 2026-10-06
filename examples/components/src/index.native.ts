import { createRegistry } from '@zyrox/react';
import { type ExampleActionHandlers, exampleActions } from './actions';
import { exampleManifestInput } from './manifest';
import { nativeComponents } from './native/components';
import { nativeMotion } from './native/motion';

export * from './native/components';
export { exampleStrings } from './strings';
export type { ExampleActionHandlers };
export { exampleManifestInput, nativeMotion };

export function createExampleRegistry(handlers?: ExampleActionHandlers) {
  return createRegistry({
    components: nativeComponents,
    actions: exampleActions(handlers),
    motion: nativeMotion,
    transitions: exampleManifestInput.transitions,
    tokens: exampleManifestInput.tokens,
  });
}
