import type { ComponentDef, Manifest, ManifestComponent } from '@zyrox/protocol';
import { defineAction, z } from '@zyrox/protocol';
import { createRegistry, type ImplementedComponent, implementAction, type Registry } from '@zyrox/react';
import type { CSSProperties, ReactNode } from 'react';

const box: CSSProperties = {
  border: '1px dashed #c7cad1',
  borderRadius: 8,
  padding: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minHeight: 28,
  background: 'rgba(79, 70, 229, 0.02)',
};
const head: CSSProperties = {
  font: '600 11px system-ui',
  color: '#6366f1',
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
};
const TEXT_PROPS = ['text', 'label', 'title', 'heading', 'name', 'value', 'placeholder', 'message'];

function summary(props: Record<string, unknown>): string {
  return Object.entries(props)
    .filter(
      ([k, v]) =>
        !TEXT_PROPS.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
    )
    .slice(0, 4)
    .map(([k, v]) => `${k}=${String(v).slice(0, 24)}`)
    .join(' · ');
}

function makePlaceholder(name: string, spec: ManifestComponent) {
  return function Placeholder(all: Record<string, any>) {
    const { slots, templates, children, nodeId: _n, a11y: _a, meta: _m, ...rest } = all;
    const handlers = Object.entries(rest).filter(([k, v]) => k.startsWith('on') && typeof v === 'function');
    const props = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('on')));
    const text = TEXT_PROPS.map((k) => props[k]).find((v) => typeof v === 'string' || typeof v === 'number');
    const image = Object.entries(props).find(
      ([k, v]) =>
        typeof v === 'string' && /^https?:\/\//.test(v) && /src|image|img|photo|avatar|thumb/i.test(k),
    )?.[1] as string | undefined;
    const press = handlers.find(
      ([k]) => k !== `on${spec.bind?.event.replace(/^./, (c) => c.toUpperCase())}`,
    )?.[1] as (() => void) | undefined;
    const bindProp = spec.bind?.prop;
    const bindHandler = spec.bind
      ? (rest[`on${spec.bind.event.replace(/^./, (c) => c.toUpperCase())}`] as
          | ((v: unknown) => void)
          | undefined)
      : undefined;
    let templateItems: ReactNode = null;
    if (spec.templates.length) {
      const list = Object.values(props).find(Array.isArray) as unknown[] | undefined;
      templateItems = (list ?? []).slice(0, 6).map((item, i) => templates[spec.templates[0]!](item, i));
    }
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: placeholder preview
      // biome-ignore lint/a11y/useKeyWithClickEvents: placeholder preview
      <div
        style={{ ...box, cursor: press ? 'pointer' : undefined }}
        onClick={press ? () => press() : undefined}
      >
        <div style={head}>
          <span>{name}</span>
          <span style={{ color: '#9ca3af', fontWeight: 400 }}>{summary(props)}</span>
        </div>
        {image ? (
          <img
            src={image}
            alt=""
            style={{ width: '100%', borderRadius: 6, maxHeight: 160, objectFit: 'cover' }}
          />
        ) : null}
        {text !== undefined ? (
          <div style={{ font: '14px system-ui', color: '#14161a' }}>{String(text)}</div>
        ) : null}
        {bindProp ? (
          typeof props[bindProp] === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(props[bindProp])}
              onChange={(e) => bindHandler?.(e.target.checked)}
            />
          ) : (
            <input
              value={String(props[bindProp] ?? '')}
              onChange={(e) => bindHandler?.(e.target.value)}
              style={{ font: '13px system-ui', padding: 4, border: '1px solid #d4d4d8', borderRadius: 4 }}
            />
          )
        ) : null}
        {children}
        {Object.entries(slots as Record<string, ReactNode>).map(([slot, content]) =>
          content ? (
            <div key={slot} style={{ borderTop: '1px dotted #e4e4e7', paddingTop: 4 }}>
              <div style={{ font: '10px system-ui', color: '#9ca3af', textTransform: 'uppercase' }}>
                {slot}
              </div>
              {content}
            </div>
          ) : null,
        )}
        {templateItems ? (
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6 }}
          >
            {templateItems}
          </div>
        ) : null}
      </div>
    );
  };
}

function defaultsOf(spec: ManifestComponent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(
    (spec.props.properties ?? {}) as Record<string, { default?: unknown }>,
  )) {
    if (s.default !== undefined) out[k] = s.default;
  }
  return out;
}

/** Generic boxes for every component in a manifest, so drafts render without the real app. */
export function placeholderRegistry(manifest: Manifest | undefined): Registry {
  const components: ImplementedComponent[] = Object.entries(manifest?.components ?? {}).map(
    ([name, spec]) => {
      const def = {
        kind: 'component',
        name,
        description: spec.description,
        props: z.looseObject({}),
        events: Object.fromEntries(Object.keys(spec.events).map((e) => [e, z.unknown()])),
        children: spec.children,
        slots: spec.slots,
        templates: spec.templates,
        bind: spec.bind,
      } as unknown as ComponentDef;
      return {
        kind: 'implemented-component',
        def,
        Component: makePlaceholder(name, spec),
        defaults: defaultsOf(spec),
      };
    },
  );
  const actions = Object.keys(manifest?.actions ?? {}).map((name) =>
    implementAction(defineAction({ name, args: z.looseObject({}) }), () =>
      console.info('[preview] action', name),
    ),
  );
  // Host helpers can't run here; echo their first argument so expressions still render.
  const helpers = Object.fromEntries(
    (manifest?.helpers ?? [])
      .filter((h) => !h.includes('.'))
      .map((h) => [h, (...args: unknown[]) => String(args[0] ?? '')]),
  );
  return createRegistry({ components, actions, helpers });
}
