import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Plus, Rocket, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { can, queryClient, useDocuments } from '../lib/queries';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  errorMessage,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  timeAgo,
  useToast,
} from '../ui';
import { useProjectContext } from './Layout';

interface RuleView {
  id?: string;
  name?: string;
  when?: string;
  rollout?: number;
  version?: number;
  experiment?: string;
}

interface ReleaseView {
  document: string;
  kind: string;
  version: number;
  ref: string;
  updatedAt: string;
  rules: RuleView[];
}

function useVersions(project: string, key: string | null) {
  return useQuery({
    queryKey: ['versions', `/projects/${project}/documents/${key}`],
    queryFn: () =>
      get<{ versions: { number: number; message: string; createdAt: string }[] }>(
        `/projects/${project}/documents/${key}/versions`,
      ),
    enabled: Boolean(key),
  });
}

export function Releases() {
  const { project, role, environments } = useProjectContext();
  const toast = useToast();
  const [env, setEnv] = useState(environments[0]?.key ?? 'dev');
  const [editing, setEditing] = useState<ReleaseView | 'new' | null>(null);
  const [promoting, setPromoting] = useState(false);
  const releases = useQuery({
    queryKey: ['releases', project.slug, env],
    queryFn: () => get<{ releases: ReleaseView[] }>(`/projects/${project.slug}/environments/${env}/releases`),
  });
  const invalidate = () =>
    queryClient
      .invalidateQueries({ queryKey: ['releases', project.slug] })
      .then(() => queryClient.invalidateQueries({ queryKey: ['documents', project.slug] }));
  const rollback = useMutation({
    mutationFn: (key: string) =>
      post<{ version: number }>(`/projects/${project.slug}/environments/${env}/releases/${key}/rollback`),
    onSuccess: async (res, key) => {
      toast(`${key} rolled back to v${res.version} in ${env}`, 'success');
      await invalidate();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const remove = useMutation({
    mutationFn: (key: string) => del(`/projects/${project.slug}/environments/${env}/releases/${key}`),
    onSuccess: invalidate,
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const publisher = can(role, 'publisher');
  return (
    <>
      <PageHeader
        title="Releases"
        description="Which version each environment serves, to whom. Changes reach apps on their next refresh (environment TTL)."
        actions={
          publisher ? (
            <>
              <Button icon={<ArrowRight className="size-4" />} onClick={() => setPromoting(true)}>
                Promote
              </Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
                Release a screen
              </Button>
            </>
          ) : null
        }
      />
      <Tabs
        className="mb-4"
        value={env}
        onChange={setEnv}
        tabs={environments.map((e) => ({ value: e.key, label: e.name }))}
      />
      {releases.isLoading ? (
        <Spinner />
      ) : releases.data?.releases.length ? (
        <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {releases.data.releases.map((r) => (
            <div key={r.document} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">{r.document}</span>
                  {r.kind === 'strings' ? <Badge>translations</Badge> : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                  <Badge tone="green">Everyone else → v{r.version}</Badge>
                  {r.rules.map((rule, i) => (
                    <Badge key={rule.id ?? i} tone="indigo" title={rule.when}>
                      {rule.name || rule.when || 'All users'}
                      {rule.rollout !== undefined && rule.rollout < 100 ? ` · ${rule.rollout}%` : ''} →{' '}
                      {rule.experiment ? `experiment ${rule.experiment}` : `v${rule.version}`}
                    </Badge>
                  ))}
                  <span>· updated {timeAgo(r.updatedAt)}</span>
                </div>
              </div>
              {publisher ? (
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    icon={<RotateCcw className="size-3.5" />}
                    loading={rollback.isPending && rollback.variables === r.document}
                    onClick={() => rollback.mutate(r.document)}
                  >
                    Roll back
                  </Button>
                  <IconButton
                    label={`Stop serving ${r.document}`}
                    icon={<Trash2 className="size-3.5" />}
                    onClick={() =>
                      confirm(`Stop serving ${r.document} in ${env}?`) && remove.mutate(r.document)
                    }
                  />
                </div>
              ) : null}
            </div>
          ))}
        </Card>
      ) : (
        <Empty icon={<Rocket className="size-8" />} title={`Nothing released to ${env} yet`}>
          Publish a screen and release it here, or use “Release a screen”.
        </Empty>
      )}
      {editing ? (
        <ReleaseDialog
          env={env}
          release={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}
      <PromoteDialog open={promoting} onClose={() => setPromoting(false)} onDone={invalidate} />
    </>
  );
}

function ReleaseDialog({
  env,
  release,
  onClose,
  onSaved,
}: {
  env: string;
  release: ReleaseView | null;
  onClose(): void;
  onSaved(): Promise<unknown>;
}) {
  const { project } = useProjectContext();
  const toast = useToast();
  const docs = useDocuments(project.slug);
  const [document, setDocument] = useState<string | null>(release?.document ?? null);
  const versions = useVersions(project.slug, document);
  const experiments = useQuery({
    queryKey: ['experiments', project.slug],
    queryFn: () =>
      get<{ experiments: { key: string; document: string; status: string }[] }>(
        `/projects/${project.slug}/experiments`,
      ),
  });
  const [version, setVersion] = useState<number | null>(release?.version ?? null);
  const [rules, setRules] = useState<RuleView[]>(release?.rules ?? []);
  const effectiveVersion = version ?? versions.data?.versions[0]?.number ?? null;
  const save = useMutation({
    mutationFn: () =>
      put(`/projects/${project.slug}/environments/${env}/releases/${document}`, {
        version: effectiveVersion,
        rules,
      }),
    onSuccess: async () => {
      toast(`Release updated in ${env}`, 'success');
      await onSaved();
      onClose();
    },
  });
  const releasable = (docs.data?.documents ?? []).filter((d) => d.kind !== 'block' && d.latest);
  const docExperiments = (experiments.data?.experiments ?? []).filter((e) => e.document === document);
  const setRule = (i: number, patch: Partial<RuleView>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={release ? `Release ${release.document} in ${env}` : `Release a document to ${env}`}
      footer={
        <>
          {save.error ? (
            <span className="mr-auto text-sm text-red-600">{errorMessage(save.error)}</span>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!document || effectiveVersion === null}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save release
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!release ? (
          <Field label="Document">
            <Select value={document ?? ''} onChange={(e) => setDocument(e.target.value || null)}>
              <option value="">Choose…</option>
              {releasable.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.key}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Default version" hint="Served to everyone no rule matches.">
          <Select
            value={effectiveVersion ?? ''}
            onChange={(e) => setVersion(Number(e.target.value))}
            disabled={!document}
          >
            {(versions.data?.versions ?? []).map((v) => (
              <option key={v.number} value={v.number}>
                v{v.number} {v.message ? `· ${v.message}` : ''} · {timeAgo(v.createdAt)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Targeting rules</span>
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() =>
                setRules([
                  ...rules,
                  { name: '', when: '', rollout: 100, version: effectiveVersion ?? undefined },
                ])
              }
              disabled={!document}
            >
              Add rule
            </Button>
          </div>
          <p className="text-xs text-zinc-500">
            First match wins. Conditions are expressions over{' '}
            <code className="font-mono">client.platform</code>, <code className="font-mono">client.app</code>,{' '}
            <code className="font-mono">attrs.*</code>, <code className="font-mono">user.id</code> and{' '}
            <code className="font-mono">locale</code>, e.g.{' '}
            <code className="font-mono">{"client.platform == 'ios' && semver(client.app, '>=3.4')"}</code>.
          </p>
          {rules.map((rule, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rules are ordered
            <Card key={i} className="grid grid-cols-12 items-end gap-2 p-3">
              <div className="col-span-3">
                <Field label="Name">
                  <Input
                    value={rule.name ?? ''}
                    onChange={(e) => setRule(i, { name: e.target.value })}
                    placeholder="iOS beta"
                  />
                </Field>
              </div>
              <div className="col-span-5">
                <Field label="When">
                  <Input
                    value={rule.when ?? ''}
                    onChange={(e) => setRule(i, { when: e.target.value })}
                    placeholder="always"
                    className="font-mono text-xs"
                  />
                </Field>
              </div>
              <div className="col-span-2">
                <Field label={`Rollout ${rule.rollout ?? 100}%`}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={rule.rollout ?? 100}
                    onChange={(e) => setRule(i, { rollout: Number(e.target.value) })}
                    aria-label="Rollout percent"
                  />
                </Field>
              </div>
              <div className="col-span-2 flex items-end gap-1">
                <Field label="Serve">
                  <Select
                    value={rule.experiment ? `exp:${rule.experiment}` : `v:${rule.version ?? ''}`}
                    onChange={(e) => {
                      const [kind, value] = e.target.value.split(':') as [string, string];
                      setRule(
                        i,
                        kind === 'exp'
                          ? { experiment: value, version: undefined }
                          : { version: Number(value), experiment: undefined },
                      );
                    }}
                  >
                    {(versions.data?.versions ?? []).map((v) => (
                      <option key={v.number} value={`v:${v.number}`}>
                        v{v.number}
                      </option>
                    ))}
                    {docExperiments.map((x) => (
                      <option key={x.key} value={`exp:${x.key}`}>
                        {x.key} ({x.status})
                      </option>
                    ))}
                  </Select>
                </Field>
                <IconButton
                  label="Remove rule"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function PromoteDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose(): void;
  onDone(): Promise<unknown>;
}) {
  const { project, environments } = useProjectContext();
  const toast = useToast();
  const [from, setFrom] = useState(environments[1]?.key ?? 'staging');
  const [to, setTo] = useState(environments[2]?.key ?? 'prod');
  const promote = useMutation({
    mutationFn: () => post<{ promoted: string[] }>(`/projects/${project.slug}/promote`, { from, to }),
    onSuccess: async (res) => {
      toast(`Promoted ${res.promoted.length} release(s) from ${from} to ${to}`, 'success');
      await onDone();
      onClose();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Promote releases"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={from === to}
            loading={promote.isPending}
            onClick={() => promote.mutate()}
          >
            Promote {from} → {to}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-zinc-500">
        Copies every release (default versions and rules) from one environment to another.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {environments.map((e) => (
              <option key={e.key}>{e.key}</option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {environments.map((e) => (
              <option key={e.key}>{e.key}</option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
