import { findNode, listNodes } from '@zyrox/core';
import type { Action, Document, Manifest, ManifestComponent, Node, Value } from '@zyrox/protocol';
import { BUILTIN_ACTIONS, LIFECYCLE_EVENTS } from '@zyrox/protocol';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, cx, Field, IconButton, Select, Tabs, useToast } from '../ui';
import { JsonInput, TextInput, ValueInput } from './fields';
import { ACTION_LISTS, BUILTIN_ACTION_SCHEMAS, type JsonSchema, properties, required } from './schema';
import { type EditorStore, useEditor } from './store';

type Tab = 'props' | 'events' | 'logic' | 'screen';

export function Inspector({ store, manifest }: { store: EditorStore; manifest?: Manifest }) {
  const snapshot = useEditor(store);
  const [tab, setTab] = useState<Tab>('props');
  const located = snapshot.selected ? findNode(snapshot.doc, snapshot.selected) : undefined;
  const node = located?.node;
  const component = node ? manifest?.components[node.type] : undefined;
  const effectiveTab = node ? tab : 'screen';
  return (
    <div className="flex h-full flex-col">
      <Tabs
        className="px-2 pt-1"
        value={effectiveTab}
        onChange={setTab}
        tabs={[
          { value: 'props', label: 'Props' },
          { value: 'events', label: 'Events' },
          { value: 'logic', label: 'Logic' },
          { value: 'screen', label: snapshot.doc.kind === 'block' ? 'Block' : 'Screen' },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {effectiveTab === 'screen' ? (
          <DocumentPanel store={store} doc={snapshot.doc} />
        ) : node ? (
          <>
            <NodeHeader node={node} component={component} known={Boolean(manifest)} />
            {effectiveTab === 'props' ? <PropsPanel store={store} node={node} component={component} /> : null}
            {effectiveTab === 'events' ? (
              <EventsPanel store={store} node={node} component={component} manifest={manifest} />
            ) : null}
            {effectiveTab === 'logic' ? (
              <LogicPanel
                store={store}
                node={node}
                component={component}
                manifest={manifest}
                doc={snapshot.doc}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function NodeHeader({
  node,
  component,
  known,
}: {
  node: Node;
  component?: ManifestComponent;
  known: boolean;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{node.type}</span>
        {known && !component && !node.type.startsWith('@block/') ? (
          <Badge tone="red">Not in app manifest</Badge>
        ) : null}
        {node.type.startsWith('@block/') ? <Badge tone="indigo">Block</Badge> : null}
      </div>
      <span className="font-mono text-xs text-zinc-500">#{node.id}</span>
      {component?.description ? <p className="mt-1 text-xs text-zinc-500">{component.description}</p> : null}
    </div>
  );
}

const update = (store: EditorStore, id: string, path: string, value: unknown, label?: string) =>
  store.apply(
    value === undefined
      ? [{ op: 'update', id, unset: [path] }]
      : [{ op: 'update', id, set: { [path]: value as Value } }],
    { label },
  );

/** A form generated from a JSON Schema, for component props and action arguments. */
export function SchemaForm({
  schema,
  values,
  onChange,
  skip = [],
  idPrefix,
}: {
  schema?: JsonSchema;
  values: Record<string, unknown>;
  onChange(key: string, value: unknown): void;
  skip?: string[];
  idPrefix: string;
}) {
  const props = properties(schema).filter(([k]) => !skip.includes(k));
  const req = required(schema);
  const unknown = Object.keys(values).filter((k) => !props.some(([p]) => p === k) && !skip.includes(k));
  if (!schema) {
    return (
      <Field
        label="Props (JSON)"
        hint="This component isn't in the app manifest, so its props can't be described."
      >
        <JsonInput value={values} onCommit={(v) => onChange('*', v)} rows={8} aria-label="Props JSON" />
      </Field>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {props.length === 0 && unknown.length === 0 ? <p className="text-xs text-zinc-500">No props.</p> : null}
      {props.map(([key, propSchema]) => (
        <Field key={key} label={key} required={req.has(key)} hint={propSchema.description}>
          <ValueInput
            id={`${idPrefix}-${key}`}
            label={key}
            schema={propSchema}
            value={values[key]}
            onChange={(v) => onChange(key, v)}
          />
        </Field>
      ))}
      {unknown.map((key) => (
        <Field
          key={key}
          label={<span className="text-amber-700">{key} (not declared, ignored by apps)</span>}
        >
          <div className="flex gap-1">
            <div className="flex-1">
              <JsonInput value={values[key]} onCommit={(v) => onChange(key, v)} rows={1} aria-label={key} />
            </div>
            <IconButton
              label={`Remove ${key}`}
              icon={<Trash2 className="size-3.5" />}
              onClick={() => onChange(key, undefined)}
            />
          </div>
        </Field>
      ))}
    </div>
  );
}

function PropsPanel({
  store,
  node,
  component,
}: {
  store: EditorStore;
  node: Node;
  component?: ManifestComponent;
}) {
  const values = (node.props ?? {}) as Record<string, unknown>;
  return (
    <div className="flex flex-col gap-4">
      <SchemaForm
        idPrefix={`prop-${node.id}`}
        schema={component?.props}
        values={values}
        skip={node.bind && component?.bind ? [component.bind.prop] : []}
        onChange={(key, value) => {
          if (key === '*')
            store.apply([{ op: 'update', id: node.id, set: { props: (value ?? {}) as Value } }], {
              label: 'Edit props',
            });
          else update(store, node.id, `props.${key}`, value, `Edit ${key}`);
        }}
      />
      {node.bind && component?.bind ? (
        <p className="rounded-lg bg-indigo-50 p-2 text-xs text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
          <b>{component.bind.prop}</b> is bound to <code className="font-mono">state.{node.bind}</code> (Logic
          tab).
        </p>
      ) : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-zinc-500">Accessibility & meta</summary>
        <div className="mt-2 flex flex-col gap-3">
          <Field label="Label">
            <ValueInput
              label="a11y label"
              schema={{ type: 'string' }}
              value={node.a11y?.label}
              onChange={(v) => update(store, node.id, 'a11y.label', v)}
            />
          </Field>
          <Field label="Hint">
            <ValueInput
              label="a11y hint"
              schema={{ type: 'string' }}
              value={node.a11y?.hint}
              onChange={(v) => update(store, node.id, 'a11y.hint', v)}
            />
          </Field>
          <Field label="Meta (JSON)" hint="Free-form data for your own tooling, passed to observers.">
            <JsonInput
              value={node.meta}
              onCommit={(v) => update(store, node.id, 'meta', v)}
              rows={2}
              aria-label="Meta"
            />
          </Field>
        </div>
      </details>
    </div>
  );
}

// --- Events ----------------------------------------------------------------------------------------

function ActionEditor({
  action,
  onChange,
  onRemove,
  onMove,
  manifest,
  depth,
  idPrefix,
}: {
  action: Action;
  onChange(a: Action): void;
  onRemove(): void;
  onMove(dir: -1 | 1): void;
  manifest?: Manifest;
  depth: number;
  idPrefix: string;
}) {
  const a = action as Action & Record<string, unknown>;
  const builtin = (BUILTIN_ACTIONS as readonly string[]).includes(a.do);
  const schema = builtin ? BUILTIN_ACTION_SCHEMAS[a.do] : manifest?.actions[a.do]?.args;
  const lists = ACTION_LISTS[a.do] ?? [];
  const { do: name, ...args } = a;
  for (const l of lists) delete (args as Record<string, unknown>)[l];
  return (
    <div className="rounded-lg ring-1 ring-zinc-200 dark:ring-zinc-800">
      <div className="flex items-center gap-1 border-b border-zinc-100 px-2 py-1 dark:border-zinc-800">
        <Select
          aria-label="Action"
          value={name}
          onChange={(e) => onChange({ do: e.target.value } as Action)}
          className="h-7 flex-1 text-xs"
        >
          <optgroup label="Built-in">
            {BUILTIN_ACTIONS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </optgroup>
          {manifest && Object.keys(manifest.actions).length ? (
            <optgroup label="Your app">
              {Object.keys(manifest.actions).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </optgroup>
          ) : null}
          {!builtin && !manifest?.actions[name] ? <option value={name}>{name} (unknown)</option> : null}
        </Select>
        <IconButton label="Move up" icon={<ChevronUp className="size-3.5" />} onClick={() => onMove(-1)} />
        <IconButton label="Move down" icon={<ChevronDown className="size-3.5" />} onClick={() => onMove(1)} />
        <IconButton label="Remove action" icon={<Trash2 className="size-3.5" />} onClick={onRemove} />
      </div>
      <div className="flex flex-col gap-3 p-2">
        <SchemaForm
          idPrefix={idPrefix}
          schema={schema}
          values={args}
          onChange={(key, value) => {
            const next = { ...a } as Record<string, unknown>;
            if (key === '*') {
              for (const k of Object.keys(next)) if (k !== 'do' && !lists.includes(k)) delete next[k];
              Object.assign(next, value as object);
            } else if (value === undefined) delete next[key];
            else next[key] = value;
            onChange(next as Action);
          }}
        />
        {depth < 3
          ? lists.map((list) => (
              <div key={list} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-zinc-500">{list}</span>
                <ActionList
                  idPrefix={`${idPrefix}-${list}`}
                  actions={(a[list] as Action[] | undefined) ?? []}
                  onChange={(next) => onChange({ ...a, [list]: next.length ? next : undefined } as Action)}
                  manifest={manifest}
                  depth={depth + 1}
                />
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

function ActionList({
  actions,
  onChange,
  manifest,
  depth = 0,
  idPrefix,
}: {
  actions: Action[];
  onChange(a: Action[]): void;
  manifest?: Manifest;
  depth?: number;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {actions.map((action, i) => (
        <ActionEditor
          // biome-ignore lint/suspicious/noArrayIndexKey: actions have no ids; order is the identity
          key={i}
          idPrefix={`${idPrefix}-${i}`}
          action={action}
          manifest={manifest}
          depth={depth}
          onChange={(a) => onChange(actions.map((x, j) => (j === i ? a : x)))}
          onRemove={() => onChange(actions.filter((_, j) => j !== i))}
          onMove={(dir) => {
            const j = i + dir;
            if (j < 0 || j >= actions.length) return;
            const next = [...actions];
            [next[i], next[j]] = [next[j]!, next[i]!];
            onChange(next);
          }}
        />
      ))}
      <Button
        size="sm"
        variant="ghost"
        icon={<Plus className="size-3.5" />}
        onClick={() => onChange([...actions, { do: 'setState', path: '' } as Action])}
        className="self-start"
      >
        Add action
      </Button>
    </div>
  );
}

function EventsPanel({
  store,
  node,
  component,
  manifest,
}: {
  store: EditorStore;
  node: Node;
  component?: ManifestComponent;
  manifest?: Manifest;
}) {
  const declared = Object.keys(component?.events ?? {});
  const events = [...new Set([...declared, ...LIFECYCLE_EVENTS, ...Object.keys(node.on ?? {})])];
  return (
    <div className="flex flex-col gap-4">
      {events.map((event) => (
        <div key={event} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{event}</span>
            {(LIFECYCLE_EVENTS as readonly string[]).includes(event) ? <Badge>lifecycle</Badge> : null}
            {component?.bind?.event === event && node.bind ? (
              <Badge tone="indigo">updates state.{node.bind}</Badge>
            ) : null}
          </div>
          <ActionList
            idPrefix={`evt-${node.id}-${event}`}
            actions={node.on?.[event] ?? []}
            manifest={manifest}
            onChange={(actions) =>
              update(store, node.id, `on.${event}`, actions.length ? actions : undefined, `Edit ${event}`)
            }
          />
        </div>
      ))}
      <p className="text-xs text-zinc-500">
        Actions run in order. Use <code className="font-mono">{'{{ event }}'}</code> for the event payload.
      </p>
    </div>
  );
}

// --- Logic -------------------------------------------------------------------------------------------

function LogicPanel({
  store,
  node,
  component,
  manifest,
  doc,
}: {
  store: EditorStore;
  node: Node;
  component?: ManifestComponent;
  manifest?: Manifest;
  doc: Document;
}) {
  const toast = useToast();
  const isRoot = doc.root.id === node.id;
  const stateKeys = Object.keys(doc.state ?? {});
  return (
    <div className="flex flex-col gap-4">
      <Field label="Show if" hint="Expression; the node renders only while it's truthy.">
        <TextInput
          value={typeof node.if === 'string' ? node.if : node.if === undefined ? '' : JSON.stringify(node.if)}
          mono
          placeholder="{{ state.loggedIn }}"
          onCommit={(v) => update(store, node.id, 'if', v || undefined, 'Edit condition')}
          aria-label="Show if"
        />
      </Field>
      {!isRoot ? (
        <fieldset className="flex flex-col gap-2 rounded-lg p-2 ring-1 ring-zinc-200 dark:ring-zinc-800">
          <legend className="px-1 text-xs font-medium text-zinc-600">Repeat</legend>
          <TextInput
            aria-label="Repeat for each"
            value={typeof node.repeat?.each === 'string' ? node.repeat.each : ''}
            mono
            placeholder="{{ data.items }}"
            onCommit={(v) =>
              update(store, node.id, 'repeat', v ? { ...node.repeat, each: v } : undefined, 'Edit repeat')
            }
          />
          {node.repeat ? (
            <div className="grid grid-cols-3 gap-2">
              <TextInput
                aria-label="Item name"
                value={node.repeat.as ?? ''}
                placeholder="item"
                mono
                onCommit={(v) => update(store, node.id, 'repeat.as', v || undefined)}
              />
              <TextInput
                aria-label="Index name"
                value={node.repeat.index ?? ''}
                placeholder="index"
                mono
                onCommit={(v) => update(store, node.id, 'repeat.index', v || undefined)}
              />
              <TextInput
                aria-label="Key"
                value={typeof node.repeat.key === 'string' ? node.repeat.key : ''}
                placeholder="{{ item.id }}"
                mono
                onCommit={(v) => update(store, node.id, 'repeat.key', v || undefined)}
              />
            </div>
          ) : null}
        </fieldset>
      ) : null}
      {component?.bind ? (
        <Field
          label={`Bind ${component.bind.prop} to state`}
          hint="Two-way: the value comes from state and updates it."
        >
          <div className="flex gap-1">
            <TextInput
              aria-label="Bind"
              value={node.bind ?? ''}
              mono
              placeholder="form.email"
              onCommit={(v) => update(store, node.id, 'bind', v || undefined, 'Edit binding')}
            />
            {stateKeys.length ? (
              <Select
                aria-label="Pick state"
                className="w-28"
                value=""
                onChange={(e) => e.target.value && update(store, node.id, 'bind', e.target.value)}
              >
                <option value="">state…</option>
                {stateKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            ) : null}
          </div>
        </Field>
      ) : null}
      <Field
        label="Local variables (with)"
        hint='JSON object of expressions, e.g. {"p": "{{ item.product }}"}'
      >
        <JsonInput
          value={node.with}
          onCommit={(v) => update(store, node.id, 'with', v, 'Edit variables')}
          rows={2}
          aria-label="Local variables"
        />
      </Field>
      <fieldset className="flex flex-col gap-2 rounded-lg p-2 ring-1 ring-zinc-200 dark:ring-zinc-800">
        <legend className="px-1 text-xs font-medium text-zinc-600">Motion</legend>
        <div className="grid grid-cols-2 gap-2">
          {(['enter', 'exit'] as const).map((k) => (
            <Select
              key={k}
              aria-label={`Motion ${k}`}
              value={node.motion?.[k] ?? ''}
              onChange={(e) =>
                update(store, node.id, `motion.${k}`, e.target.value || undefined, 'Edit motion')
              }
            >
              <option value="">{k}: none</option>
              {(manifest?.motions ?? []).map((m) => (
                <option key={m} value={m}>
                  {k}: {m}
                </option>
              ))}
            </Select>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={Boolean(node.motion?.layout)}
            onChange={(e) => update(store, node.id, 'motion.layout', e.target.checked || undefined)}
          />
          Animate layout changes
        </label>
        {!manifest?.motions.length ? (
          <span className="text-xs text-zinc-500">Your app has no motion adapter in its manifest.</span>
        ) : null}
      </fieldset>
      {!isRoot ? (
        <Field label="Fallback" hint="Rendered by app builds that don't have this component.">
          {node.fallback ? (
            <div className="flex items-center justify-between rounded-lg px-2 py-1.5 text-xs ring-1 ring-zinc-200 dark:ring-zinc-800">
              <span>
                {node.fallback.type} <span className="font-mono text-zinc-500">#{node.fallback.id}</span>
              </span>
              <IconButton
                label="Remove fallback"
                icon={<Trash2 className="size-3.5" />}
                onClick={() =>
                  store.apply([{ op: 'remove', id: node.fallback!.id }], { label: 'Remove fallback' })
                }
              />
            </div>
          ) : (
            <Select
              aria-label="Add fallback"
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                const ids = new Set(listNodes(doc).map((l) => l.node.id));
                let id = `${node.id}-fallback`;
                for (let i = 2; ids.has(id); i++) id = `${node.id}-fallback-${i}`;
                const error = store.tryApply(
                  [{ op: 'insert', parent: node.id, slot: 'fallback', node: { id, type: e.target.value } }],
                  { label: 'Add fallback', select: id },
                );
                if (error) toast(error, 'error');
              }}
            >
              <option value="">Add a fallback…</option>
              {Object.keys(manifest?.components ?? {}).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </Field>
      ) : null}
    </div>
  );
}

// --- Document ------------------------------------------------------------------------------------------

function DocumentPanel({ store, doc }: { store: EditorStore; doc: Document }) {
  const set = (path: string, value: unknown, label: string) =>
    store.apply(
      value === undefined ? [{ op: 'doc', unset: [path] }] : [{ op: 'doc', set: { [path]: value as Value } }],
      { label },
    );
  return (
    <div className="flex flex-col gap-4">
      <Field label="Title">
        <TextInput
          value={doc.title ?? ''}
          onCommit={(v) => set('title', v || undefined, 'Edit title')}
          aria-label="Title"
        />
      </Field>
      <Field label="Initial state" hint="JSON. Read with {{ state.x }}, change with setState or bindings.">
        <JsonInput
          value={doc.state}
          onCommit={(v) => set('state', v, 'Edit state')}
          rows={6}
          aria-label="Initial state"
        />
      </Field>
      {doc.kind === 'screen' ? (
        <Field label="Params" hint='Screen parameters, e.g. {"id": {"type": "string", "required": true}}'>
          <JsonInput
            value={doc.params}
            onCommit={(v) => set('params', v, 'Edit params')}
            rows={3}
            aria-label="Params"
          />
        </Field>
      ) : (
        <p className="text-xs text-zinc-500">
          Inside a block, the instance props are available as{' '}
          <code className="font-mono">{'{{ input.x }}'}</code>.
        </p>
      )}
      <Field
        label="Data sources"
        hint='Fetched by your app with its own auth. {"product": {"url": "/products/{{ params.id }}", "refresh": ["mount"], "mock": {…}}}'
      >
        <JsonInput
          value={doc.data}
          onCommit={(v) => set('data', v, 'Edit data sources')}
          rows={10}
          aria-label="Data sources"
        />
      </Field>
      <Field
        label="Forms"
        hint='Validation rules for state you bind inputs to. {"signup": {"fields": {"email": {"required": true, "email": true}}}}'
      >
        <JsonInput
          value={doc.forms}
          onCommit={(v) => set('forms', v, 'Edit forms')}
          rows={6}
          aria-label="Forms"
        />
      </Field>
      <div className={cx('text-xs text-zinc-500')}>
        Key: <code className="font-mono">{doc.key}</code>
      </div>
    </div>
  );
}
