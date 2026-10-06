import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { post } from '../lib/api';
import { can, queryClient } from '../lib/queries';
import type { CompatEntry, Environment, Problem, Role } from '../lib/types';
import { Badge, Button, Dialog, errorMessage, Field, Input, Spinner, useToast } from '../ui';
import type { EditorStore } from './store';

export function PublishDialog({
  open,
  onClose,
  store,
  endpoint,
  environments,
  role,
  projectSlug,
  isBlock,
}: {
  open: boolean;
  onClose(): void;
  store: EditorStore;
  endpoint: string;
  environments: Environment[];
  role: Role;
  projectSlug: string;
  isBlock: boolean;
}) {
  const toast = useToast();
  const [message, setMessage] = useState('');
  const [release, setRelease] = useState<string[]>(['dev']);
  const check = useQuery({
    queryKey: ['validate', endpoint, open],
    enabled: open,
    gcTime: 0,
    queryFn: async () => {
      await store.settled();
      return post<{ problems: Problem[]; compat: CompatEntry[]; manifest?: { label: string } }>(
        `${endpoint}/validate`,
        { content: store.doc },
      );
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      await store.settled();
      return post<{ version: { number: number } }>(`${endpoint}/publish`, {
        message,
        release: isBlock ? [] : release,
        revision: store.getSnapshot().revision,
      });
    },
    onSuccess: async (res) => {
      toast(
        `Published v${res.version.number}${!isBlock && release.length ? ` to ${release.join(', ')}` : ''}`,
        'success',
      );
      setMessage('');
      await queryClient.invalidateQueries({ queryKey: ['documents', projectSlug] });
      onClose();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });
  const errors = check.data?.problems.filter((p) => p.level === 'error') ?? [];
  const warnings = check.data?.problems.filter((p) => p.level === 'warning') ?? [];
  const brokenShare = (check.data?.compat ?? []).reduce((sum, c) => sum + c.share, 0);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publish"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!can(role, 'publisher') || check.isLoading || errors.length > 0}
            loading={publish.isPending}
            onClick={() => publish.mutate()}
          >
            {isBlock
              ? 'Publish block'
              : release.length
                ? `Publish & release to ${release.join(', ')}`
                : 'Publish version'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!can(role, 'publisher') ? (
          <p className="text-sm text-amber-700">You need the publisher role to publish.</p>
        ) : null}
        {check.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Checking against your app builds…
          </div>
        ) : errors.length ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm dark:bg-red-950/50">
            <p className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
              <XCircle className="size-4" /> Fix {errors.length} problem{errors.length === 1 ? '' : 's'} first
            </p>
            <ul className="mt-2 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
              {errors.slice(0, 8).map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static list
                <li key={i}>
                  {p.nodeId ? <code className="font-mono">#{p.nodeId}</code> : null} {p.message}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="size-4" /> Valid against{' '}
            {check.data?.manifest
              ? `the latest app build${check.data.manifest.label ? ` (${check.data.manifest.label})` : ''}`
              : 'the protocol (no manifest uploaded)'}
            {warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}
          </p>
        )}
        {check.data?.compat.length ? (
          <div className="rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
            <p className="flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-200">
              <AlertTriangle className="size-4" /> Older app builds ({Math.round(brokenShare * 100)}% of
              recent traffic) can't render everything
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-xs">
              {check.data.compat.map((c) => (
                <li key={c.hash}>
                  <Badge tone="amber">{c.label || c.hash.slice(0, 10)}</Badge> {Math.round(c.share * 100)}% ·{' '}
                  {c.problems.map((p) => p.message).join('; ')}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
              Add a fallback to those nodes, or target newer builds with a release rule.
            </p>
          </div>
        ) : null}
        <Field label="Message">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed?" />
        </Field>
        {!isBlock ? (
          <Field label="Release to" hint="Apps in these environments get this version on their next refresh.">
            <div className="flex flex-wrap gap-3">
              {environments.map((env) => (
                <label key={env.key} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={release.includes(env.key)}
                    onChange={(e) =>
                      setRelease(
                        e.target.checked ? [...release, env.key] : release.filter((r) => r !== env.key),
                      )
                    }
                  />
                  {env.name}
                </label>
              ))}
            </div>
          </Field>
        ) : (
          <p className="text-xs text-zinc-500">
            Screens that use this block pick up the new version when they're published next.
          </p>
        )}
      </div>
    </Dialog>
  );
}
