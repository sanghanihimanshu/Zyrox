import { Braces, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx, Input, Select, Switch, Textarea } from '../ui';
import { enumValues, fieldKind, isTemplate, type JsonSchema, widget } from './schema';

/** Local text state that commits after a pause or on blur, so undo isn't one step per keystroke. */
function useCommit<T>(value: T, commit: (v: T) => void, delay = 400) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef(local);
  latest.current = local;
  useEffect(() => setLocal(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (v: T) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(v), delay);
  };
  const flush = () => {
    clearTimeout(timer.current);
    if (latest.current !== value) commit(latest.current);
  };
  return [local, change, flush] as const;
}

export function TextInput({
  value,
  onCommit,
  placeholder,
  mono,
  id,
  multiline,
  'aria-label': ariaLabel,
}: {
  value: string;
  onCommit(v: string): void;
  placeholder?: string;
  mono?: boolean;
  id?: string;
  multiline?: boolean;
  'aria-label'?: string;
}) {
  const [local, change, flush] = useCommit(value, onCommit);
  const className = cx(mono && 'font-mono text-xs');
  return multiline ? (
    <Textarea
      id={id}
      aria-label={ariaLabel}
      rows={3}
      value={local}
      placeholder={placeholder}
      className={className}
      onChange={(e) => change(e.target.value)}
      onBlur={flush}
    />
  ) : (
    <Input
      id={id}
      aria-label={ariaLabel}
      value={local}
      placeholder={placeholder}
      className={className}
      onChange={(e) => change(e.target.value)}
      onBlur={flush}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush();
      }}
    />
  );
}

/** Edits any JSON value as text. */
export function JsonInput({
  value,
  onCommit,
  rows = 4,
  id,
  'aria-label': ariaLabel,
}: {
  value: unknown;
  onCommit(v: unknown): void;
  rows?: number;
  id?: string;
  'aria-label'?: string;
}) {
  const text = value === undefined ? '' : JSON.stringify(value, null, 2);
  const [error, setError] = useState<string | null>(null);
  const commit = (raw: string) => {
    if (!raw.trim()) {
      setError(null);
      onCommit(undefined);
      return;
    }
    try {
      onCommit(JSON.parse(raw));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const [local, change, flush] = useCommit(text, commit, 700);
  return (
    <div className="flex flex-col gap-1">
      <Textarea
        id={id}
        aria-label={ariaLabel}
        rows={rows}
        value={local}
        onChange={(e) => change(e.target.value)}
        onBlur={flush}
        className="font-mono text-xs"
        spellCheck={false}
      />
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}

/**
 * Edits one value according to its JSON Schema, with an `ƒx` toggle to switch to an expression
 * (`{{ … }}`) instead of a literal.
 */
export function ValueInput({
  schema,
  value,
  onChange,
  id,
  label,
}: {
  schema?: JsonSchema;
  value: unknown;
  onChange(v: unknown): void;
  id?: string;
  label: string;
}) {
  const [expression, setExpression] = useState(isTemplate(value));
  useEffect(() => {
    if (isTemplate(value)) setExpression(true);
  }, [value]);
  const kind = fieldKind(schema);
  const w = widget(schema);
  const toggle = (
    <button
      type="button"
      title={expression ? 'Use a fixed value' : 'Use an expression'}
      aria-label={expression ? `Use a fixed value for ${label}` : `Use an expression for ${label}`}
      aria-pressed={expression}
      onClick={() => {
        if (expression) {
          setExpression(false);
          if (isTemplate(value)) onChange(undefined);
        } else {
          setExpression(true);
          onChange(`{{ ${value === undefined ? '' : JSON.stringify(value)} }}`.replace('{{  }}', '{{ }}'));
        }
      }}
      className={cx(
        'grid size-7 shrink-0 place-items-center rounded-md text-xs',
        expression
          ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
          : 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800',
      )}
    >
      <Braces className="size-3.5" />
    </button>
  );

  let control: React.ReactNode;
  if (expression) {
    control = (
      <TextInput
        id={id}
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onCommit={onChange}
        mono
        placeholder="{{ state.value }}"
      />
    );
  } else if (kind === 'enum') {
    const options = enumValues(schema!) ?? [];
    control = (
      <Select
        id={id}
        aria-label={label}
        value={value === undefined ? '' : String(value)}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : options.find((o) => String(o) === e.target.value))
        }
      >
        <option value="">
          {schema?.default !== undefined ? `Default (${String(schema.default)})` : '—'}
        </option>
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </Select>
    );
  } else if (kind === 'boolean') {
    control = (
      <div className="flex h-9 items-center gap-2">
        <Switch label={label} checked={Boolean(value ?? schema?.default)} onChange={onChange} />
        {value !== undefined ? (
          <button
            type="button"
            className="text-zinc-400 hover:text-zinc-700"
            title="Reset to default"
            aria-label={`Reset ${label}`}
            onClick={() => onChange(undefined)}
          >
            <Undo2 className="size-3.5" />
          </button>
        ) : (
          <span className="text-xs text-zinc-400">default</span>
        )}
      </div>
    );
  } else if (kind === 'number' || kind === 'integer') {
    control = (
      <TextInput
        id={id}
        aria-label={label}
        value={value === undefined ? '' : String(value)}
        placeholder={schema?.default !== undefined ? String(schema.default) : undefined}
        onCommit={(v) => {
          if (!v.trim()) return onChange(undefined);
          const n = Number(v);
          if (Number.isFinite(n)) onChange(kind === 'integer' ? Math.round(n) : n);
        }}
      />
    );
  } else if (kind === 'string') {
    control =
      w === 'color' ? (
        <div className="flex w-full gap-2">
          <input
            type="color"
            aria-label={`${label} color`}
            value={typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="h-9 w-10 rounded"
          />
          <TextInput
            id={id}
            aria-label={label}
            value={typeof value === 'string' ? value : ''}
            onCommit={(v) => onChange(v || undefined)}
            mono
          />
        </div>
      ) : (
        <TextInput
          id={id}
          aria-label={label}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={
            schema?.default !== undefined
              ? String(schema.default)
              : w === 'image' || w === 'url'
                ? 'https://…'
                : undefined
          }
          multiline={w === 'multiline'}
          onCommit={(v) => onChange(v === '' ? undefined : v)}
        />
      );
  } else {
    control = (
      <JsonInput id={id} aria-label={label} value={value} onCommit={onChange} rows={kind === 'any' ? 2 : 4} />
    );
  }

  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">{control}</div>
      {toggle}
    </div>
  );
}
