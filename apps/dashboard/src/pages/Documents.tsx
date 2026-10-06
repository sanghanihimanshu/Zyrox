import { useMutation } from '@tanstack/react-query';
import { Blocks, FilePlus2, LayoutTemplate, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { post } from '../lib/api';
import { can, queryClient, useDocuments, useLatestManifest } from '../lib/queries';
import type { DocumentSummary } from '../lib/types';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  errorMessage,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  timeAgo,
} from '../ui';
import { useProjectContext } from './Layout';

export function Documents() {
  const { project, role, environments } = useProjectContext();
  const docs = useDocuments(project.slug);
  const { manifest, isLoading: manifestLoading } = useLatestManifest(project.slug);
  const [tab, setTab] = useState<'screen' | 'block'>('screen');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useMemo(
    () =>
      (docs.data?.documents ?? []).filter(
        (d) => d.kind === tab && (d.key + d.title).toLowerCase().includes(query.toLowerCase()),
      ),
    [docs.data, tab, query],
  );
  return (
    <>
      <PageHeader
        title="Screens & blocks"
        description="Screens are delivered to apps. Blocks are reusable pieces you drop into screens."
        actions={
          can(role, 'editor') ? (
            <Button
              variant="primary"
              icon={<FilePlus2 className="size-4" />}
              onClick={() => setCreating(true)}
            >
              New {tab}
            </Button>
          ) : null
        }
      />
      {!manifestLoading && !manifest ? (
        <Card className="mb-4 border-l-4 border-amber-400 p-4 text-sm">
          <p className="font-medium">No app manifest yet</p>
          <p className="mt-1 text-zinc-500">
            Upload what your app supports so the editor knows your components:{' '}
            <code className="rounded bg-zinc-100 px-1 font-mono text-xs dark:bg-zinc-800">
              npx zyrox manifest push --project {project.slug}
            </code>
          </p>
        </Card>
      ) : null}
      <div className="mb-3 flex items-center justify-between gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'screen', label: 'Screens' },
            { value: 'block', label: 'Blocks' },
          ]}
        />
        <div className="relative w-64">
          <Search className="absolute top-2.5 left-2.5 size-4 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="pl-8"
            aria-label="Search documents"
          />
        </div>
      </div>
      {docs.isLoading ? (
        <Spinner />
      ) : list.length ? (
        <Card className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {list.map((d) => (
            <DocumentRow key={d.id} doc={d} envs={environments.map((e) => e.key)} />
          ))}
        </Card>
      ) : (
        <Empty
          icon={tab === 'screen' ? <LayoutTemplate className="size-8" /> : <Blocks className="size-8" />}
          title={`No ${tab}s yet`}
        >
          {tab === 'screen'
            ? 'Create a screen, build it from your components and release it to an environment.'
            : 'Blocks are reusable fragments with inputs.'}
        </Empty>
      )}
      <CreateDocument
        open={creating}
        kind={tab}
        onClose={() => setCreating(false)}
        hasManifest={Boolean(manifest)}
      />
    </>
  );
}

function DocumentRow({ doc, envs }: { doc: DocumentSummary; envs: string[] }) {
  return (
    <Link
      href={`/edit/${doc.key}`}
      className="flex items-center gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{doc.title || doc.key}</span>
          {doc.dirty ? <Badge tone="amber">Unpublished changes</Badge> : null}
        </div>
        <span className="font-mono text-xs text-zinc-500">{doc.key}</span>
      </div>
      <div className="hidden items-center gap-1.5 sm:flex">
        {envs.map((env) =>
          doc.live[env] ? (
            <Badge
              key={env}
              tone="green"
              title={doc.live[env]!.rules ? `${doc.live[env]!.rules} targeting rule(s)` : undefined}
            >
              {env} v{doc.live[env]!.number}
              {doc.live[env]!.rules ? ' +rules' : ''}
            </Badge>
          ) : (
            <Badge key={env}>{env} —</Badge>
          ),
        )}
      </div>
      <span className="w-24 text-right text-xs text-zinc-500">{timeAgo(doc.updatedAt)}</span>
    </Link>
  );
}

function CreateDocument({
  open,
  kind,
  onClose,
  hasManifest,
}: {
  open: boolean;
  kind: 'screen' | 'block';
  onClose(): void;
  hasManifest: boolean;
}) {
  const { project } = useProjectContext();
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState(kind);
  const [, navigate] = useLocation();
  const create = useMutation({
    mutationFn: () => post(`/projects/${project.slug}/documents`, { key, kind: type, title }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['documents', project.slug] });
      onClose();
      navigate(`/edit/${key}`);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New document"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!key}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as 'screen' | 'block')}>
            <option value="screen">Screen</option>
            <option value="block">Block</option>
          </Select>
        </Field>
        <Field label="Key" hint="Your app opens screens by key, e.g. home or checkout/payment">
          <Input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9._/-]/g, '-'))}
            className="font-mono"
            placeholder="home"
          />
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Home" />
        </Field>
        {!hasManifest ? (
          <p className="text-xs text-amber-700">
            Without a manifest the new screen starts with a generic "Screen" container.
          </p>
        ) : null}
        {create.error ? <p className="text-sm text-red-600">{errorMessage(create.error)}</p> : null}
      </div>
    </Dialog>
  );
}
