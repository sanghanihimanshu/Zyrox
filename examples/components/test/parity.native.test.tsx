import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ZyroxProvider, ZyroxScreen } from '@zyrox/react';
import { defaultOverlays } from '@zyrox/react/overlays';
import { ZyroxRemote } from '@zyrox/react/remote';
import { documents } from '../documents';
import { createExampleRegistry, exampleStrings } from '../src/index.native';
import { scenarios } from './scenarios';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe.each(scenarios)('native: $name', (scenario) => {
  it('behaves like web', async () => {
    const spies = {
      navigate: jest.fn(),
      addToCart: jest.fn(),
      fetcher: jest.fn(scenario.api ?? (async () => ({ name: 'Ada' }))),
    };
    await render(
      <ZyroxProvider
        registry={createExampleRegistry({ addToCart: spies.addToCart })}
        navigate={spies.navigate}
        fetcher={spies.fetcher}
        mock={scenario.mock}
        strings={exampleStrings}
        locale="en"
        app={{ user: { name: 'Ada' } }}
        documents={documents}
        overlays={defaultOverlays}
      >
        {scenario.triggers ? (
          <ZyroxRemote triggers={scenario.triggers as never} storage={memoryStorage()} />
        ) : null}
        <ZyroxScreen document={scenario.document} params={scenario.params} />
      </ZyroxProvider>,
    );
    await flush();
    for (const step of scenario.steps) {
      if ('wait' in step) await act(() => new Promise((r) => setTimeout(r, step.wait)));
      else if ('text' in step) expect(screen.getAllByText(step.text).length).toBeGreaterThan(0);
      else if ('noText' in step) expect(screen.queryByText(step.noText)).toBeNull();
      else if ('press' in step) await fireEvent.press(screen.getByRole('button', { name: step.press }));
      else if ('type' in step) await fireEvent.changeText(screen.getByLabelText(step.type), step.value);
      else if ('blur' in step) await fireEvent(screen.getByLabelText(step.blur), 'blur');
      else if ('toggle' in step) {
        const toggle = screen.getByLabelText(step.toggle);
        await fireEvent(toggle, 'valueChange', !toggle.props.value);
      } else if ('called' in step)
        expect(spies[step.called]).toHaveBeenCalledWith(
          ...step.with.map((a) =>
            a && typeof a === 'object' && !Array.isArray(a)
              ? expect.objectContaining(a as Record<string, unknown>)
              : a,
          ),
        );
      await flush();
    }
  });
});

describe('manifest', () => {
  it('the native registry reports the same manifest as web', () => {
    const { buildManifest } = require('@zyrox/protocol');
    const { exampleManifestInput } = require('../src/index.native');
    expect(createExampleRegistry().manifest.hash).toBe(buildManifest(exampleManifestInput).hash);
  });
});
