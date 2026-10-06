import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ZyroxProvider, ZyroxScreen } from '@wishyor/zyrox-react';
import { defaultOverlays } from '@wishyor/zyrox-react/overlays';
import { ZyroxRemote } from '@wishyor/zyrox-react/remote';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documents } from '../documents';
import { createExampleRegistry, exampleStrings } from '../src/index';
import { scenarios } from './scenarios';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

afterEach(cleanup);
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe.each(scenarios)('web: $name', (scenario) => {
  it('behaves like native', async () => {
    const spies = {
      navigate: vi.fn(),
      addToCart: vi.fn(),
      fetcher: vi.fn(scenario.api ?? (async () => ({ name: 'Ada' }))),
    };
    render(
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
      else if ('press' in step) fireEvent.click(screen.getByRole('button', { name: step.press }));
      else if ('type' in step)
        fireEvent.change(screen.getByLabelText(step.type), { target: { value: step.value } });
      else if ('blur' in step) fireEvent.blur(screen.getByLabelText(step.blur));
      else if ('toggle' in step) fireEvent.click(screen.getByRole('switch', { name: step.toggle }));
      else if ('called' in step)
        expect(spies[step.called]).toHaveBeenCalledWith(
          ...step.with.map((a) =>
            a && typeof a === 'object' && !Array.isArray(a) ? expect.objectContaining(a) : a,
          ),
        );
      await flush();
    }
  });
});

describe('manifest', () => {
  it('the web registry reports the manifest the CLI uploads', async () => {
    const { buildManifest } = await import('@wishyor/zyrox-protocol');
    const { exampleManifestInput } = await import('../src/index');
    expect(createExampleRegistry().manifest.hash).toBe(buildManifest(exampleManifestInput).hash);
  });
});
