import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { del, get, patch, post, put } from '../lib/api';
import { can, queryClient, useManifests } from '../lib/queries';
import type { Role } from '../lib/types';
import {
  Badge,
  Button,
  Card,
  errorMessage,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  Switch,
  Tabs,
  timeAgo,
  useToast,
} from '../ui';
import { useProjectContext } from './Layout';

type Section =
  | 'project'
  | 'environments'
  | 'members'
  | 'functions'
  | 'webhooks'
  | 'headless'
  | 'builds'
  | 'tokens'
  | 'agents'
  | 'audit';

export function Settings() {
  const { role } = useProjectContext();
  const [section, setSection] = useState<Section>('project');
  const sections: { value: Section; label: string }[] = [
    { value: 'project', label: 'Project' },
    { value: 'environments', label: 'Environments & keys' },
    { value: 'members', label: 'Members' },
    { value: 'functions', label: 'Functions' },
    { value: 'webhooks', label: 'Webhooks' },
    { value: 'headless', label: 'Previews & export' },
    { value: 'builds', label: 'App builds' },
    { value: 'tokens', label: 'Access tokens' },
    { value: 'agents', label: 'AI & agents' },
    { value: 'audit', label: 'Audit log' },
  ];
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs className="mb-5" value={section} onChange={setSection} tabs={sections} />
      {section === 'project' ? <ProjectSettings admin={can(role, 'admin')} /> : null}
      {section === 'environments' ? <EnvironmentSettings admin={can(role, 'admin')} /> : null}
      {section === 'members' ? <Members admin={can(role, 'admin')} /> : null}
      {section === 'functions' ? <Functions admin={can(role, 'admin')} /> : null}
      {section === 'webhooks' ? <Webhooks admin={can(role, 'admin')} /> : null}
      {section === 'headless' ? (
        <>
          <PreviewTokens editor={can(role, 'editor')} />
          <ExportImport admin={can(role, 'admin')} />
        </>
      ) : null}
      {section === 'builds' ? <Builds /> : null}
      {section === 'tokens' ? <Tokens /> : null}
      {section === 'agents' ? <Agents /> : null}
      {section === 'audit' ? <Audit /> : null}
    </>
  );
}

function Copyable({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="truncate rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
        {value}
      </code>
      <IconButton
        label={`Copy ${label}`}
        icon={<Copy className="size-3.5" />}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          toast('Copied');
        }}
      />
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="mb-4 p-5">
      <h2 className="font-medium">{title}</h2>
      {description ? (
        <p className="mt-1 mb-4 text-sm text-zinc-500">{description}</p>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </Card>
  );
}

function ProjectSettings({ admin }: { admin: boolean }) {
  const { project } = useProjectContext();
  const toast = useToast();
  const [form, setForm] = useState({
    name: project.name,
    defaultLocale: project.defaultLocale,
    previewUrl: project.previewUrl ?? '',
  });
  const save = useMutation({
    mutationFn: () => patch(`/projects/${project.slug}`, { ...form, previewUrl: form.previewUrl || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['project', project.slug] });
      toast('Saved', 'success');
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  return (
    <Section title="Project">
      <div className="grid max-w-xl gap-3">
        <Field label="Name">
          <Input
            value={form.name}
            disabled={!admin}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Default language" hint="Fallback for missing translations">
          <Input
            value={form.defaultLocale}
            disabled={!admin}
            onChange={(e) => setForm({ ...form, defaultLocale: e.target.value })}
            className="font-mono"
          />
        </Field>
        <Field
          label="Preview URL"
          hint={
            <>
              A route in your web app that renders <code className="font-mono">{'<ZyroxPreviewHost />'}</code>
              . The editor canvas then shows your real components. Leave empty for placeholders.
            </>
          }
        >
          <Input
            value={form.previewUrl}
            disabled={!admin}
            onChange={(e) => setForm({ ...form, previewUrl: e.target.value })}
            placeholder="http://localhost:5173/__zyrox/preview"
          />
        </Field>
        {admin ? (
          <Button
            variant="primary"
            className="justify-self-start"
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function EnvironmentSettings({ admin }: { admin: boolean }) {
  const { project, environments } = useProjectContext();
  const toast = useToast();
  const update = useMutation({
    mutationFn: ({ key, body }: { key: string; body: Record<string, unknown> }) =>
      patch(`/projects/${project.slug}/environments/${key}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', project.slug] }),
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  return (
    <Section
      title="Environments"
      description={
        <>
          Each environment has a public, read-only key for your app:{' '}
          <code className="font-mono">{'<ZyroxProvider endpoint="…" publicKey="pk_…" />'}</code>.
        </>
      }
    >
      <div className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
        {environments.map((env) => (
          <div key={env.key} className="flex flex-wrap items-center gap-3 py-3">
            <div className="w-32">
              <div className="font-medium">{env.name}</div>
              <div className="font-mono text-xs text-zinc-500">{env.key}</div>
            </div>
            <div className="min-w-0 flex-1">
              <Copyable value={env.publicKey} label={`${env.key} public key`} />
            </div>
            <span className="flex items-center gap-1 text-xs text-zinc-500">
              Refresh every
              <Input
                aria-label={`${env.key} refresh interval in seconds`}
                type="number"
                className="h-7 w-20"
                defaultValue={env.ttl}
                disabled={!admin}
                onBlur={(e) =>
                  Number(e.target.value) !== env.ttl &&
                  update.mutate({ key: env.key, body: { ttl: Number(e.target.value) } })
                }
              />
              s
            </span>
            {admin ? (
              <Button
                size="sm"
                icon={<RefreshCw className="size-3.5" />}
                onClick={() =>
                  confirm(`Rotate the ${env.key} key? Apps using the old key stop loading screens.`) &&
                  update.mutate({ key: env.key, body: { rotateKey: true } })
                }
              >
                Rotate key
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </Section>
  );
}

function Members({ admin }: { admin: boolean }) {
  const { project } = useProjectContext();
  const toast = useToast();
  const members = useQuery({
    queryKey: ['members', project.slug],
    queryFn: () =>
      get<{ members: { id: string; email: string; name: string; role: Role }[] }>(
        `/projects/${project.slug}/members`,
      ),
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const set = useMutation({
    mutationFn: (body: { email: string; role: Role }) => put(`/projects/${project.slug}/members`, body),
    onSuccess: () => {
      setEmail('');
      return queryClient.invalidateQueries({ queryKey: ['members', project.slug] });
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/projects/${project.slug}/members/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', project.slug] }),
  });
  return (
    <Section
      title="Members"
      description="Viewers read, editors change drafts, publishers publish and release, admins manage the project."
    >
      {(members.data?.members ?? []).map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-3 border-t border-zinc-100 py-2 text-sm dark:border-zinc-800"
        >
          <div className="flex-1">
            {m.name} <span className="text-zinc-500">{m.email}</span>
          </div>
          <Select
            value={m.role}
            disabled={!admin}
            className="h-8 w-36"
            onChange={(e) => set.mutate({ email: m.email, role: e.target.value as Role })}
            aria-label={`Role of ${m.email}`}
          >
            {(['viewer', 'editor', 'publisher', 'admin'] as Role[]).map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          {admin ? (
            <IconButton
              label={`Remove ${m.email}`}
              icon={<Trash2 className="size-3.5" />}
              onClick={() => remove.mutate(m.id)}
            />
          ) : null}
        </div>
      ))}
      {admin ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            set.mutate({ email, role });
          }}
        >
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            aria-label="Email"
          />
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-36"
            aria-label="Role"
          >
            {(['viewer', 'editor', 'publisher', 'admin'] as Role[]).map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <Button type="submit" icon={<Plus className="size-4" />}>
            Add
          </Button>
        </form>
      ) : null}
      <p className="mt-2 text-xs text-zinc-500">
        People need an account on this server first (the owner creates accounts, or sign-up is open).
      </p>
    </Section>
  );
}

interface FunctionRow {
  name: string;
  kind: 'code' | 'webhook';
  url?: string;
  enabled?: boolean;
  timeoutMs?: number;
}

function Functions({ admin }: { admin: boolean }) {
  const { project } = useProjectContext();
  const toast = useToast();
  const list = useQuery({
    queryKey: ['functions', project.slug],
    queryFn: () => get<{ functions: FunctionRow[] }>(`/projects/${project.slug}/functions`),
  });
  const [form, setForm] = useState({ name: '', url: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['functions', project.slug] });
  const create = useMutation({
    mutationFn: () => post<{ function: { secret: string } }>(`/projects/${project.slug}/functions`, form),
    onSuccess: (res) => {
      setSecret(res.function.secret);
      setForm({ name: '', url: '' });
      return refresh();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const update = useMutation({
    mutationFn: ({ name, body }: { name: string; body: object }) =>
      patch(`/projects/${project.slug}/functions/${name}`, body),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) => del(`/projects/${project.slug}/functions/${name}`),
    onSuccess: refresh,
  });
  const test = async (name: string) => {
    const res = await post<{ ok: boolean; result?: unknown; error?: string; durationMs?: number }>(
      `/projects/${project.slug}/functions/${name}/test`,
      { args: {} },
    );
    setTestResult((r) => ({
      ...r,
      [name]: res.ok ? `✓ ${JSON.stringify(res.result)} (${res.durationMs}ms)` : `✗ ${res.error}`,
    }));
  };
  return (
    <Section
      title="Remote functions"
      description={
        <>
          Documents call them with{' '}
          <code className="font-mono">{'{ "do": "call", "fn": "name", "args": {…}, "into": "result" }'}</code>
          . Code functions run inside the Zyrox server; webhooks forward signed requests to your cloud
          (Lambda, Cloud Run, Firebase, Vercel).
        </>
      }
    >
      {(list.data?.functions ?? []).map((f) => (
        <div
          key={f.name}
          className="flex flex-wrap items-center gap-3 border-t border-zinc-100 py-2 text-sm dark:border-zinc-800"
        >
          <span className="w-40 font-mono">{f.name}</span>
          <Badge tone={f.kind === 'code' ? 'indigo' : 'zinc'}>{f.kind}</Badge>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">
            {f.url ?? 'registered in server code'}
          </span>
          {testResult[f.name] ? (
            <span className="max-w-xs truncate font-mono text-xs">{testResult[f.name]}</span>
          ) : null}
          <Button size="sm" onClick={() => void test(f.name)}>
            Test
          </Button>
          {f.kind === 'webhook' && admin ? (
            <>
              <Switch
                label={`Enable ${f.name}`}
                checked={Boolean(f.enabled)}
                onChange={(enabled) => update.mutate({ name: f.name, body: { enabled } })}
              />
              <IconButton
                label={`Delete ${f.name}`}
                icon={<Trash2 className="size-3.5" />}
                onClick={() => confirm(`Delete ${f.name}?`) && remove.mutate(f.name)}
              />
            </>
          ) : null}
        </div>
      ))}
      {admin ? (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="applyCoupon"
            className="w-48 font-mono"
            aria-label="Function name"
          />
          <Input
            required
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://…/zyrox/applyCoupon"
            aria-label="Function URL"
          />
          <Button type="submit" icon={<Plus className="size-4" />} loading={create.isPending}>
            Add webhook
          </Button>
        </form>
      ) : null}
      {secret ? (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <p className="mb-1 font-medium">Signing secret (shown once)</p>
          <Copyable value={secret} label="secret" />
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Verify requests with{' '}
            <code className="font-mono">verifySignature(secret, timestamp, body, signature)</code> from{' '}
            <code className="font-mono">@zyrox/server</code>.
          </p>
        </div>
      ) : null}
    </Section>
  );
}

interface WebhookRow {
  id: string;
  url: string;
  description: string;
  events: string[];
  enabled: boolean;
  lastDelivery: Delivery | null;
}

interface Delivery {
  id: string;
  event: string;
  status: number;
  ok: boolean;
  attempt: number;
  error: string;
  durationMs: number;
  createdAt: string;
}

const WEBHOOK_EVENTS = [
  { value: '*', label: 'Everything' },
  { value: 'document.*', label: 'Documents (publish, create, restore, archive)' },
  { value: 'release.*', label: 'Releases (set, rollback, promote, remove)' },
  { value: 'experiment.*', label: 'Experiments' },
  { value: 'translate', label: 'Translations' },
];

function DeliveryBadge({ delivery }: { delivery: Delivery | null }) {
  if (!delivery) return <Badge>no deliveries</Badge>;
  return (
    <Badge tone={delivery.ok ? 'green' : 'red'}>
      {delivery.event} · {delivery.status || 'failed'} · {timeAgo(delivery.createdAt)}
    </Badge>
  );
}

function Webhooks({ admin }: { admin: boolean }) {
  const { project } = useProjectContext();
  const toast = useToast();
  const key = ['webhooks', project.slug];
  const list = useQuery({
    queryKey: key,
    queryFn: () => get<{ webhooks: WebhookRow[] }>(`/projects/${project.slug}/webhooks`),
    enabled: admin,
  });
  const [form, setForm] = useState({ url: '', events: '*', description: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const create = useMutation({
    mutationFn: () =>
      post<{ webhook: { secret: string } }>(`/projects/${project.slug}/webhooks`, {
        url: form.url,
        events: [form.events],
        description: form.description,
      }),
    onSuccess: (res) => {
      setSecret(res.webhook.secret);
      setForm({ url: '', events: '*', description: '' });
      return refresh();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: object }) =>
      patch<{ webhook: { secret?: string } }>(`/projects/${project.slug}/webhooks/${id}`, body),
    onSuccess: (res) => {
      if (res.webhook.secret) setSecret(res.webhook.secret);
      return refresh();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/projects/${project.slug}/webhooks/${id}`),
    onSuccess: refresh,
  });
  const ping = useMutation({
    mutationFn: (id: string) => post<{ delivery: Delivery }>(`/projects/${project.slug}/webhooks/${id}/test`),
    onSuccess: (res) => {
      toast(
        res.delivery.ok
          ? `Delivered (${res.delivery.status})`
          : `Failed: ${res.delivery.error || res.delivery.status}`,
        res.delivery.ok ? 'success' : 'error',
      );
      return refresh();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  if (!admin)
    return (
      <Section title="Webhooks">
        <p className="text-sm text-zinc-500">Only admins manage webhooks.</p>
      </Section>
    );
  return (
    <Section
      title="Webhooks"
      description={
        <>
          Your systems hear about changes: publishes, releases, rollbacks… Each event is a signed{' '}
          <code className="font-mono">POST</code> (<code className="font-mono">x-zyrox-signature</code>),
          retried with backoff when your endpoint fails. Use it to trigger CI, purge a CDN, notify a channel
          or sync a CMS.
        </>
      }
    >
      {(list.data?.webhooks ?? []).map((hook) => (
        <div key={hook.id} className="border-t border-zinc-100 py-2 text-sm dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{hook.url}</span>
            <span className="text-xs text-zinc-500">{hook.events.join(', ')}</span>
            <DeliveryBadge delivery={hook.lastDelivery} />
            <Button
              size="sm"
              loading={ping.isPending && ping.variables === hook.id}
              onClick={() => ping.mutate(hook.id)}
            >
              Send test
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(open === hook.id ? null : hook.id)}>
              {open === hook.id ? 'Hide log' : 'Log'}
            </Button>
            <Switch
              label={`Enable ${hook.url}`}
              checked={hook.enabled}
              onChange={(enabled) => update.mutate({ id: hook.id, body: { enabled } })}
            />
            <IconButton
              label={`Rotate secret of ${hook.url}`}
              icon={<RefreshCw className="size-3.5" />}
              onClick={() =>
                confirm('Rotate the signing secret? Update your endpoint with the new one.') &&
                update.mutate({ id: hook.id, body: { rotateSecret: true } })
              }
            />
            <IconButton
              label={`Delete ${hook.url}`}
              icon={<Trash2 className="size-3.5" />}
              onClick={() => confirm(`Delete the webhook to ${hook.url}?`) && remove.mutate(hook.id)}
            />
          </div>
          {hook.description ? <p className="mt-1 text-xs text-zinc-500">{hook.description}</p> : null}
          {open === hook.id ? <DeliveryLog webhookId={hook.id} /> : null}
        </div>
      ))}
      <form
        className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_16rem_14rem_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Input
          required
          type="url"
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          placeholder="https://ci.example.com/hooks/zyrox"
          aria-label="Webhook URL"
        />
        <Select
          aria-label="Events"
          value={form.events}
          onChange={(e) => setForm({ ...form, events: e.target.value })}
        >
          {WEBHOOK_EVENTS.map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </Select>
        <Input
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="What it's for (optional)"
          aria-label="Webhook description"
        />
        <Button type="submit" icon={<Plus className="size-4" />} loading={create.isPending}>
          Add webhook
        </Button>
      </form>
      {secret ? (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <p className="mb-1 font-medium">Signing secret (shown once)</p>
          <Copyable value={secret} label="webhook secret" />
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Verify deliveries with{' '}
            <code className="font-mono">verifySignature(secret, timestamp, body, signature)</code> from{' '}
            <code className="font-mono">@zyrox/server</code>, and ignore repeated{' '}
            <code className="font-mono">x-zyrox-delivery</code> ids.
          </p>
        </div>
      ) : null}
    </Section>
  );
}

function DeliveryLog({ webhookId }: { webhookId: string }) {
  const { project } = useProjectContext();
  const log = useQuery({
    queryKey: ['webhook-deliveries', project.slug, webhookId],
    queryFn: () =>
      get<{ deliveries: Delivery[] }>(`/projects/${project.slug}/webhooks/${webhookId}/deliveries`),
  });
  const rows = log.data?.deliveries ?? [];
  return (
    <div className="mt-2 rounded-lg bg-zinc-50 p-2 font-mono text-xs dark:bg-zinc-900">
      {rows.length ? null : <p className="text-zinc-500">Nothing delivered yet.</p>}
      {rows.map((d) => (
        <div key={d.id} className="flex gap-3 py-0.5">
          <span className={d.ok ? 'text-emerald-600' : 'text-red-600'}>{d.ok ? '✓' : '✗'}</span>
          <span className="w-36">{d.event}</span>
          <span className="w-16">{d.status || '—'}</span>
          <span className="w-16">try {d.attempt}</span>
          <span className="w-16">{d.durationMs}ms</span>
          <span className="w-24 text-zinc-500">{timeAgo(d.createdAt)}</span>
          <span className="min-w-0 flex-1 truncate text-zinc-500">{d.error}</span>
        </div>
      ))}
    </div>
  );
}

function PreviewTokens({ editor }: { editor: boolean }) {
  const { project } = useProjectContext();
  const toast = useToast();
  const [minutes, setMinutes] = useState(24 * 60);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const create = useMutation({
    mutationFn: () =>
      post<{ token: string; expiresAt: string }>(`/projects/${project.slug}/preview-tokens`, {
        expiresInMinutes: minutes,
      }),
    onSuccess: setIssued,
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  return (
    <Section
      title="Draft previews"
      description={
        <>
          A preview token makes a real app build, or your site's server rendering, show drafts instead of
          releases: pass it as <code className="font-mono">previewToken</code> to{' '}
          <code className="font-mono">{'<ZyroxProvider>'}</code> (QA and review builds) or to{' '}
          <code className="font-mono">fetchScreen</code> (draft mode). It works in every environment of this
          project and expires on its own.
        </>
      }
    >
      {editor ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-40">
            <Select
              aria-label="Token lifetime"
              value={String(minutes)}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="w-40"
            >
              <option value={60}>1 hour</option>
              <option value={24 * 60}>1 day</option>
              <option value={7 * 24 * 60}>7 days</option>
              <option value={30 * 24 * 60}>30 days</option>
            </Select>
          </div>
          <Button
            icon={<KeyRound className="size-4" />}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create preview token
          </Button>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">Editors create preview tokens.</p>
      )}
      {issued ? (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <p className="mb-1 font-medium">
            Preview token, valid until {new Date(issued.expiresAt).toLocaleString()}
          </p>
          <Copyable value={issued.token} label="preview token" />
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            Anyone with it sees this project's drafts. Rotating the server's secret key revokes all tokens.
          </p>
        </div>
      ) : null}
    </Section>
  );
}

interface ImportSummary {
  created: string[];
  updated: string[];
  skipped: string[];
  versions: number;
  releases: number;
  functions: { name: string; secret: string }[];
  webhooks: { url: string; secret: string }[];
  problems: { document: string; message: string }[];
}

function ExportImport({ admin }: { admin: boolean }) {
  const { project } = useProjectContext();
  const toast = useToast();
  const [history, setHistory] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const exportProject = useMutation({
    mutationFn: () => get(`/projects/${project.slug}/export${history ? '?versions=true' : ''}`),
    onSuccess: (bundle) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${project.slug}.zyrox.json`;
      link.click();
      URL.revokeObjectURL(url);
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const importProject = useMutation({
    mutationFn: async (file: File) =>
      post<ImportSummary>(`/projects/${project.slug}/import`, {
        bundle: JSON.parse(await file.text()),
        overwrite,
      }),
    onSuccess: (res) => {
      setSummary(res);
      void queryClient.invalidateQueries();
      toast('Imported', 'success');
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  if (!admin) return null;
  return (
    <Section
      title="Export and import"
      description="Move screens between servers or projects, start a project from a template, or keep a portable copy. Exports never contain secrets; imported functions and webhooks get new ones."
    >
      <div className="flex flex-wrap items-center gap-4">
        <Switch label="Include version history and releases" checked={history} onChange={setHistory} />
        <span className="text-sm">Include version history and releases</span>
        <Button loading={exportProject.isPending} onClick={() => exportProject.mutate()}>
          Download export
        </Button>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <Switch label="Replace drafts of existing documents" checked={overwrite} onChange={setOverwrite} />
        <span className="text-sm">Replace drafts of existing documents</span>
        <label className="cursor-pointer text-sm font-medium text-indigo-600 hover:text-indigo-500">
          {importProject.isPending ? 'Importing…' : 'Import a file…'}
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="Import file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importProject.mutate(file);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {summary ? (
        <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
          <p>
            {summary.created.length} created · {summary.updated.length} updated · {summary.skipped.length}{' '}
            kept · {summary.versions} versions · {summary.releases} releases
          </p>
          {[
            ...summary.functions.map((f) => ({ label: `Function ${f.name}`, secret: f.secret })),
            ...summary.webhooks.map((w) => ({ label: `Webhook ${w.url}`, secret: w.secret })),
          ].map((s) => (
            <div key={s.label} className="mt-1 flex items-center gap-2">
              <span className="text-xs text-zinc-500">{s.label}: new secret</span>
              <Copyable value={s.secret} label="secret" />
            </div>
          ))}
          {summary.problems.map((p) => (
            <p key={`${p.document}:${p.message}`} className="mt-1 text-xs text-red-600">
              {p.document}: {p.message}
            </p>
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function Builds() {
  const { project } = useProjectContext();
  const manifests = useManifests(project.slug);
  return (
    <Section
      title="App builds"
      description={
        <>
          Each build uploads what it supports with{' '}
          <code className="font-mono">zyrox manifest push --label 1.2.3</code> (run it in CI). Publishing
          checks documents against builds still in use.
        </>
      }
    >
      {(manifests.data?.manifests ?? []).map((m) => (
        <div
          key={m.hash}
          className="flex flex-wrap items-center gap-3 border-t border-zinc-100 py-2 text-sm dark:border-zinc-800"
        >
          <span className="w-28">{m.label || '—'}</span>
          <code className="font-mono text-xs text-zinc-500">{m.hash.slice(0, 14)}</code>
          {m.latest ? <Badge tone="indigo">latest</Badge> : null}
          <span className="text-xs text-zinc-500">
            {Object.keys(m.manifest.components).length} components · {Object.keys(m.manifest.actions).length}{' '}
            actions
          </span>
          <span className="ml-auto text-xs text-zinc-500">
            {(m.share * 100).toFixed(1)}% of traffic · uploaded {timeAgo(m.uploadedAt)}
          </span>
        </div>
      ))}
      {!manifests.data?.manifests.length ? (
        <p className="text-sm text-zinc-500">No manifests uploaded yet.</p>
      ) : null}
    </Section>
  );
}

interface TokenRow {
  id: string;
  name: string;
  project: string | null;
  role: Role | null;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

function Tokens() {
  const toast = useToast();
  const { project } = useProjectContext();
  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: () => get<{ tokens: TokenRow[] }>('/tokens'),
  });
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [role, setRole] = useState<Role | ''>('editor');
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      post<{ token: string }>('/tokens', {
        name,
        ...(scope === 'project' ? { project: project.slug } : {}),
        ...(role ? { role } : {}),
        ...(days ? { expiresInDays: Number(days) } : {}),
      }),
    onSuccess: (res) => {
      setCreated(res.token);
      setName('');
      return queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/tokens/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  });
  return (
    <Section
      title="Personal access tokens"
      description="For the CLI, CI and AI agents (MCP). They act as you, limited to the project, role and lifetime you choose. Prefer the smallest scope that works."
    >
      {(tokens.data?.tokens ?? []).map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-3 border-t border-zinc-100 py-2 text-sm dark:border-zinc-800"
        >
          <KeyRound className="size-4 text-zinc-400" />
          <span className="flex-1">{t.name}</span>
          <Badge>{t.project ?? 'all projects'}</Badge>
          <Badge>{t.role ? `≤ ${t.role}` : 'your role'}</Badge>
          <span className="text-xs text-zinc-500">
            {t.expiresAt
              ? new Date(t.expiresAt) < new Date()
                ? 'expired'
                : `expires ${new Date(t.expiresAt).toLocaleDateString()}`
              : 'never expires'}{' '}
            · used {timeAgo(t.lastUsedAt)}
          </span>
          <IconButton
            label={`Revoke ${t.name}`}
            icon={<Trash2 className="size-3.5" />}
            onClick={() => remove.mutate(t.id)}
          />
        </div>
      ))}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="CI"
          className="w-48"
          aria-label="Token name"
        />
        <Select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'project' | 'all')}
          aria-label="Token projects"
          className="w-44"
        >
          <option value="project">Only {project.slug}</option>
          <option value="all">All my projects</option>
        </Select>
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as Role | '')}
          aria-label="Token role"
          className="w-40"
        >
          <option value="viewer">Read only</option>
          <option value="editor">Up to editor</option>
          <option value="publisher">Up to publisher</option>
          <option value="">My full role</option>
        </Select>
        <Select
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-label="Token expiry"
          className="w-36"
        >
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
          <option value="">No expiry</option>
        </Select>
        <Button type="submit" icon={<Plus className="size-4" />}>
          Create token
        </Button>
      </form>
      {created ? (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          <p className="mb-1 font-medium">Copy it now; it won't be shown again</p>
          <Copyable value={created} label="token" />
          <p className="mt-1 text-xs">
            <code className="font-mono">npx zyrox login --server {location.origin} --token …</code>
          </p>
        </div>
      ) : null}
    </Section>
  );
}

/** How to connect coding agents (MCP + skills), and what AI features this server has. */
function Agents() {
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () =>
      get<{
        enabled: boolean;
        model: string | null;
        translation: { provider: string; runtime: boolean } | null;
      }>('/ai/status'),
  });
  const url = `${location.origin}/mcp`;
  const command = `claude mcp add --transport http zyrox ${url} --header "Authorization: Bearer $ZYROX_TOKEN"`;
  const yes = (on: boolean | undefined, label: string) =>
    on ? <Badge tone="green">{label}</Badge> : <Badge>off</Badge>;
  return (
    <>
      <Section
        title="Connect AI agents (MCP)"
        description="Claude Code, Cursor and other MCP clients get your design system and screens: design context, component map, tokens, scaffolding, validated edits and live device previews. Publishing stays with people."
      >
        <div className="flex flex-col gap-3 text-sm">
          <Field label="MCP endpoint">
            <Copyable value={url} label="MCP endpoint" />
          </Field>
          <Field
            label="Claude Code"
            hint="Create a personal access token under Access tokens and export it as ZYROX_TOKEN."
          >
            <Copyable value={command} label="command" />
          </Field>
          <Field label="Guides for agents">
            <Copyable value="npx zyrox skills install" label="command" />
          </Field>
          <Field label="Design-system rules for your repository">
            <Copyable
              value="npx zyrox skills rules --out .claude/rules/zyrox-design-system.md"
              label="command"
            />
          </Field>
        </div>
      </Section>
      <Section
        title="AI on this server"
        description="Configured with environment variables on the server (ANTHROPIC_API_KEY, ZYROX_TRANSLATOR, ZYROX_RUNTIME_TRANSLATION)."
      >
        <dl className="grid grid-cols-[12rem_1fr] gap-y-2 text-sm">
          <dt className="text-zinc-500">Editor assistant</dt>
          <dd>
            {yes(status.data?.enabled, 'on')}{' '}
            {status.data?.model ? <code className="font-mono text-xs">{status.data.model}</code> : null}
          </dd>
          <dt className="text-zinc-500">Translation provider</dt>
          <dd>
            {status.data?.translation ? (
              <Badge tone="green">{status.data.translation.provider}</Badge>
            ) : (
              <Badge>none</Badge>
            )}
          </dd>
          <dt className="text-zinc-500">Runtime translation in apps</dt>
          <dd>{yes(status.data?.translation?.runtime, 'on')}</dd>
        </dl>
      </Section>
    </>
  );
}

function Audit() {
  const { project } = useProjectContext();
  const audit = useQuery({
    queryKey: ['audit', project.slug],
    queryFn: () =>
      get<{
        entries: {
          id: string;
          action: string;
          target: string;
          actor: string | null;
          createdAt: string;
          details: Record<string, unknown>;
        }[];
      }>(`/projects/${project.slug}/audit`),
  });
  return (
    <Section title="Audit log">
      <div className="flex flex-col font-mono text-xs">
        {(audit.data?.entries ?? []).map((e) => (
          <div key={e.id} className="flex gap-3 border-t border-zinc-100 py-1.5 dark:border-zinc-800">
            <span className="w-28 shrink-0 text-zinc-500">{timeAgo(e.createdAt)}</span>
            <span className="w-24 shrink-0 truncate">{e.actor ?? 'system'}</span>
            <span className="w-36 shrink-0 text-indigo-600">{e.action}</span>
            <span className="truncate">{e.target}</span>
            <span className="truncate text-zinc-500">
              {Object.keys(e.details).length ? JSON.stringify(e.details) : ''}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}
