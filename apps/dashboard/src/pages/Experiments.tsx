import { useMutation, useQuery } from '@tanstack/react-query';
import { FlaskConical, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { get, patch, post } from '../lib/api';
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
  timeAgo,
  useToast,
} from '../ui';
import { useProjectContext } from './Layout';

interface Experiment {
  key: string;
  name: string;
  status: 'draft' | 'running' | 'stopped';
  document: string;
  createdAt: string;
  variants: { key: string; weight: number; version?: number }[];
}

export function Experiments() {
  const { project, role, environments } = useProjectContext();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [env, setEnv] = useState(environments.at(-1)?.key ?? 'prod');
  const list = useQuery({
    queryKey: ['experiments', project.slug],
    queryFn: () => get<{ experiments: Experiment[] }>(`/projects/${project.slug}/experiments`),
  });
  const health = useQuery({
    queryKey: ['health', project.slug, env, 30],
    queryFn: () =>
      get<{ experiments: Record<string, Record<string, number>> }>(
        `/projects/${project.slug}/health?env=${env}&days=30`,
      ),
  });
  const setStatus = useMutation({
    mutationFn: ({ key, status }: { key: string; status: string }) =>
      patch(`/projects/${project.slug}/experiments/${key}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['experiments', project.slug] }),
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  return (
    <>
      <PageHeader
        title="Experiments"
        description="Split users between versions of a screen. Assignment is sticky per user; exposure events go to your analytics through observers."
        actions={
          can(role, 'publisher') ? (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New experiment
            </Button>
          ) : null
        }
      />
      <div className="mb-3 flex items-center gap-2 text-sm text-zinc-500">
        Exposures (30 days) in
        <Select
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          className="w-40"
          aria-label="Environment"
        >
          {environments.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name}
            </option>
          ))}
        </Select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.data?.experiments.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {list.data.experiments.map((x) => {
            const exposures = health.data?.experiments[x.key] ?? {};
            const total = Object.values(exposures).reduce((a, b) => a + b, 0);
            return (
              <Card key={x.key} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{x.name || x.key}</span>
                      <Badge
                        tone={x.status === 'running' ? 'green' : x.status === 'stopped' ? 'zinc' : 'amber'}
                      >
                        {x.status}
                      </Badge>
                    </div>
                    <span className="font-mono text-xs text-zinc-500">
                      {x.key} · {x.document} · {timeAgo(x.createdAt)}
                    </span>
                  </div>
                  {can(role, 'publisher') ? (
                    x.status === 'running' ? (
                      <Button
                        size="sm"
                        icon={<Pause className="size-3.5" />}
                        onClick={() => setStatus.mutate({ key: x.key, status: 'stopped' })}
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Play className="size-3.5" />}
                        onClick={() => setStatus.mutate({ key: x.key, status: 'running' })}
                      >
                        Start
                      </Button>
                    )
                  ) : null}
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  {x.variants.map((v) => {
                    const count = exposures[v.key] ?? 0;
                    return (
                      <div key={v.key} className="text-xs">
                        <div className="flex justify-between">
                          <span>
                            <b>{v.key}</b> → v{v.version} · {v.weight}%
                          </span>
                          <span className="text-zinc-500">{count.toLocaleString()} exposures</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div
                            className="h-1.5 rounded-full bg-indigo-500"
                            style={{ width: `${total ? (count / total) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {x.status === 'running' ? (
                  <p className="mt-3 text-xs text-zinc-500">
                    Serve it from a release rule (Releases → Edit → Serve: {x.key}).
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : (
        <Empty icon={<FlaskConical className="size-8" />} title="No experiments yet">
          Publish two versions of a screen, then compare them here.
        </Empty>
      )}
      {creating ? <CreateExperiment onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function CreateExperiment({ onClose }: { onClose(): void }) {
  const { project } = useProjectContext();
  const docs = useDocuments(project.slug);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [document, setDocument] = useState('');
  const [variants, setVariants] = useState([
    { key: 'control', version: 0, weight: 50 },
    { key: 'variant', version: 0, weight: 50 },
  ]);
  const versions = useQuery({
    queryKey: ['versions', `/projects/${project.slug}/documents/${document}`],
    queryFn: () =>
      get<{ versions: { number: number; message: string }[] }>(
        `/projects/${project.slug}/documents/${document}/versions`,
      ),
    enabled: Boolean(document),
  });
  const create = useMutation({
    mutationFn: () => post(`/projects/${project.slug}/experiments`, { key, name, document, variants }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['experiments', project.slug] });
      onClose();
    },
  });
  const screens = (docs.data?.documents ?? []).filter((d) => d.kind === 'screen' && d.latest);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="New experiment"
      footer={
        <>
          {create.error ? (
            <span className="mr-auto text-sm text-red-600">{errorMessage(create.error)}</span>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!key || !document || variants.some((v) => !v.version)}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Key">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value.replace(/[^a-z0-9_-]/gi, '-'))}
              className="font-mono"
              placeholder="home-hero"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Home hero copy" />
          </Field>
        </div>
        <Field label="Screen">
          <Select value={document} onChange={(e) => setDocument(e.target.value)}>
            <option value="">Choose…</option>
            {screens.map((d) => (
              <option key={d.key}>{d.key}</option>
            ))}
          </Select>
        </Field>
        {variants.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ordered variants
          <div key={i} className="grid grid-cols-12 items-end gap-2">
            <div className="col-span-4">
              <Field label="Variant">
                <Input
                  value={v.key}
                  onChange={(e) =>
                    setVariants(variants.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                  }
                />
              </Field>
            </div>
            <div className="col-span-4">
              <Field label="Version">
                <Select
                  value={v.version || ''}
                  onChange={(e) =>
                    setVariants(
                      variants.map((x, j) => (j === i ? { ...x, version: Number(e.target.value) } : x)),
                    )
                  }
                >
                  <option value="">Choose…</option>
                  {(versions.data?.versions ?? []).map((ver) => (
                    <option key={ver.number} value={ver.number}>
                      v{ver.number} {ver.message}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="col-span-3">
              <Field label="Weight %">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={v.weight}
                  onChange={(e) =>
                    setVariants(
                      variants.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)),
                    )
                  }
                />
              </Field>
            </div>
            <div className="col-span-1">
              {variants.length > 2 ? (
                <IconButton
                  label="Remove variant"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={() => setVariants(variants.filter((_, j) => j !== i))}
                />
              ) : null}
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-3.5" />}
          className="self-start"
          onClick={() =>
            setVariants([...variants, { key: `variant-${variants.length}`, version: 0, weight: 0 }])
          }
        >
          Add variant
        </Button>
      </div>
    </Dialog>
  );
}
