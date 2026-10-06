import { useMutation } from '@tanstack/react-query';
import { FolderPlus, LogOut, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { del, post } from '../lib/api';
import { queryClient, useMe } from '../lib/queries';
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
  Spinner,
  useToast,
} from '../ui';
import { Logo } from './Logo';

export function Projects() {
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [, navigate] = useLocation();
  const logout = useMutation({
    mutationFn: () => post('/auth/logout'),
    onSuccess: () => {
      queryClient.clear();
      navigate('/login');
    },
  });
  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-lg font-semibold">Zyrox</span>
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          {me.data?.user.email}
          <Link
            href="/profile"
            className="flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <UserRound className="size-3.5" />
            Profile
          </Link>
          <Button
            variant="ghost"
            size="sm"
            icon={<LogOut className="size-3.5" />}
            onClick={() => logout.mutate()}
          >
            Sign out
          </Button>
        </div>
      </div>
      <PageHeader
        title="Projects"
        description="One project per app. Each has development, staging and production environments."
        actions={
          <Button
            variant="primary"
            icon={<FolderPlus className="size-4" />}
            onClick={() => setCreating(true)}
          >
            New project
          </Button>
        }
      />
      {me.isLoading ? (
        <Spinner />
      ) : me.data?.projects.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {me.data.projects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <Empty title="No projects yet">
          Create a project for your app, then upload its manifest with the CLI.
        </Empty>
      )}
      <CreateProject open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ProjectRow({
  project,
}: {
  project: NonNullable<ReturnType<typeof useMe>['data']>['projects'][number];
}) {
  const toast = useToast();
  const remove = useMutation({
    mutationFn: () => del(`/projects/${project.slug}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      toast(`Deleted ${project.name}`, 'success');
    },
    onError: (error) => toast(errorMessage(error), 'error'),
  });
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Link href={`/p/${project.slug}`} className="min-w-0 flex-1">
        <Card className="cursor-pointer p-4 transition-shadow hover:shadow-md">
          <div className="flex items-center justify-between">
            <span className="font-medium">{project.name}</span>
            <Badge>{project.role}</Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-zinc-500">{project.slug}</p>
        </Card>
      </Link>
      {project.role === 'admin' ? (
        <IconButton
          label={`Delete ${project.name}`}
          icon={<Trash2 className="size-4" />}
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Delete ${project.name} and all of its data? This cannot be undone.`))
              remove.mutate();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateProject({ open, onClose }: { open: boolean; onClose(): void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [, navigate] = useLocation();
  const create = useMutation({
    mutationFn: () => post<{ project: { slug: string } }>('/projects', { name, slug }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      navigate(`/p/${res.project.slug}`);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!name || !slug}
            onClick={() => create.mutate()}
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(
                e.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 40),
              );
            }}
            placeholder="Shop app"
          />
        </Field>
        <Field label="Slug" hint="Used in URLs and the CLI">
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} className="font-mono" />
        </Field>
        {create.error ? <p className="text-sm text-red-600">{errorMessage(create.error)}</p> : null}
      </div>
    </Dialog>
  );
}
