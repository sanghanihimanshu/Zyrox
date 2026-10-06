import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Languages, Plus, Rocket, Search, Trash2, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { get, post, put } from '../lib/api';
import { can, queryClient, useDocuments } from '../lib/queries';
import type { Draft, StringsContent } from '../lib/types';
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
import { useProjectContext } from './Layout';

/** All translation bundles side by side: one row per key, one column per locale. */
export function Translations() {
  const { project, role, environments } = useProjectContext();
  const toast = useToast();
  const docs = useDocuments(project.slug);
  const bundles = (docs.data?.documents ?? []).filter((d) => d.kind === 'strings');
  const drafts = useQueries({
    queries: bundles.map((b) => ({
      queryKey: ['draft', `/projects/${project.slug}/documents/${b.key}`],
      queryFn: () => get<{ draft: Draft }>(`/projects/${project.slug}/documents/${b.key}`),
    })),
  });
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [newKey, setNewKey] = useState('');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const locales = bundles.map((b) => b.key.slice('strings/'.length));
  const loaded = drafts.every((d) => d.data);
  const messages = (locale: string): Record<string, string> => {
    const i = locales.indexOf(locale);
    const base = (drafts[i]?.data?.draft.content as StringsContent | undefined)?.messages ?? {};
    return { ...base, ...edits[locale] };
  };
  const all = new Set<string>();
  for (const l of locales) for (const k of Object.keys(messages(l))) all.add(k);
  const keys = [...all].filter((k) => k.toLowerCase().includes(query.toLowerCase())).sort();
  const dirty = Object.keys(edits).length > 0;

  const save = useMutation({
    mutationFn: async (publish: boolean) => {
      for (const [i, locale] of locales.entries()) {
        const key = bundles[i]!.key;
        const current = drafts[i]!.data!.draft;
        const content = {
          ...(current.content as StringsContent),
          messages: Object.fromEntries(Object.entries(messages(locale)).filter(([, v]) => v !== '')),
        };
        if (edits[locale])
          await put(`/projects/${project.slug}/documents/${key}/draft`, {
            content,
            revision: current.revision,
          });
        if (publish)
          await post(`/projects/${project.slug}/documents/${key}/publish`, {
            release: environments.map((e) => e.key).filter((k) => k === 'dev'),
          });
      }
    },
    onSuccess: async (_r, publish) => {
      setEdits({});
      await queryClient.invalidateQueries({ queryKey: ['draft'] });
      await queryClient.invalidateQueries({ queryKey: ['documents', project.slug] });
      toast(publish ? 'Translations published to development' : 'Saved', 'success');
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const setMessage = (locale: string, key: string, value: string) =>
    setEdits((e) => ({ ...e, [locale]: { ...e[locale], [key]: value } }));

  // Machine translation with the server's provider (Claude, DeepL, LibreTranslate, your own…).
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => get<{ translation: { provider: string; runtime: boolean } | null }>('/ai/status'),
    staleTime: 5 * 60_000,
  });
  const provider = status.data?.translation?.provider;
  const source = locales.includes(project.defaultLocale) ? messages(project.defaultLocale) : {};
  const missing = (locale: string) => {
    const current = messages(locale);
    return Object.fromEntries(Object.entries(source).filter(([k, v]) => v && !current[k]));
  };
  const missingCount = locales
    .filter((l) => l !== project.defaultLocale)
    .reduce((n, l) => n + Object.keys(missing(l)).length, 0);
  const translate = useMutation({
    mutationFn: async () => {
      let filled = 0;
      for (const locale of locales) {
        if (locale === project.defaultLocale) continue;
        const entries = Object.entries(missing(locale));
        for (let i = 0; i < entries.length; i += 300) {
          const res = await post<{ messages: Record<string, string> }>(
            `/projects/${project.slug}/translate`,
            {
              sourceLocale: project.defaultLocale,
              locale,
              messages: Object.fromEntries(entries.slice(i, i + 300)),
            },
          );
          filled += Object.keys(res.messages).length;
          setEdits((e) => ({ ...e, [locale]: { ...e[locale], ...res.messages } }));
        }
      }
      return filled;
    },
    onSuccess: (filled) =>
      toast(
        filled ? `Filled ${filled} translations. Review them, then save.` : 'Nothing to translate',
        'success',
      ),
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  return (
    <>
      <PageHeader
        title="Translations"
        description={
          <>
            Use <code className="font-mono">{"{{ t('key', { name: 'Ada' }) }}"}</code> in documents. Plurals:{' '}
            <code className="font-mono">{'{count, plural, one {# item} other {# items}}'}</code>. Apps fetch
            these at runtime and fall back to the default locale ({project.defaultLocale}).
          </>
        }
        actions={
          can(role, 'editor') ? (
            <>
              <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                Add language
              </Button>
              {provider ? (
                <Button
                  icon={<Wand2 className="size-4" />}
                  disabled={!missingCount}
                  loading={translate.isPending}
                  onClick={() => translate.mutate()}
                  title={`Fills empty cells from ${project.defaultLocale} with ${provider}`}
                >
                  Translate missing{missingCount ? ` (${missingCount})` : ''}
                </Button>
              ) : null}
              <Button
                disabled={!dirty}
                loading={save.isPending && !save.variables}
                onClick={() => save.mutate(false)}
              >
                Save
              </Button>
              {can(role, 'publisher') ? (
                <Button
                  variant="primary"
                  icon={<Rocket className="size-4" />}
                  loading={save.isPending && save.variables}
                  onClick={() => save.mutate(true)}
                >
                  Publish to dev
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      {docs.isLoading || !loaded ? (
        <Spinner />
      ) : !locales.length ? (
        <Empty icon={<Languages className="size-8" />} title="No languages yet">
          Add a language to start translating. Apps can also ship their own strings and translate missing keys
          at runtime.
        </Empty>
      ) : (
        <Card className="overflow-x-auto">
          <div className="flex items-center gap-2 border-b border-zinc-100 p-3 dark:border-zinc-800">
            <div className="relative w-64">
              <Search className="absolute top-2.5 left-2.5 size-4 text-zinc-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search keys"
                className="pl-8"
                aria-label="Search keys"
              />
            </div>
            {can(role, 'editor') ? (
              <form
                className="ml-auto flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!newKey) return;
                  for (const l of locales) setMessage(l, newKey, messages(l)[newKey] ?? '');
                  setNewKey('');
                }}
              >
                <Input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value.trim())}
                  placeholder="new.key"
                  className="w-48 font-mono"
                  aria-label="New key"
                />
                <Button type="submit" icon={<Plus className="size-4" />}>
                  Add key
                </Button>
              </form>
            ) : null}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="px-3 py-2 font-medium">Key</th>
                {locales.map((l, i) => (
                  <th key={l} className="px-3 py-2 font-medium">
                    {l} {l === project.defaultLocale ? <Badge>default</Badge> : null}{' '}
                    {bundles[i]?.dirty ? <Badge tone="amber">unpublished</Badge> : null}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                  <td className="px-3 py-2 font-mono text-xs">{key}</td>
                  {locales.map((l) => {
                    const value = messages(l)[key] ?? '';
                    return (
                      <td key={l} className="px-2 py-1">
                        <Input
                          aria-label={`${key} in ${l}`}
                          value={value}
                          disabled={!can(role, 'editor')}
                          onChange={(e) => setMessage(l, key, e.target.value)}
                          className={value ? '' : 'ring-amber-300 dark:ring-amber-800'}
                          placeholder="Missing"
                        />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1">
                    {can(role, 'editor') ? (
                      <IconButton
                        label={`Delete ${key}`}
                        icon={<Trash2 className="size-3.5" />}
                        onClick={() => {
                          for (const l of locales) setMessage(l, key, '');
                        }}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <AddLanguage open={adding} onClose={() => setAdding(false)} existing={locales} />
    </>
  );
}

function AddLanguage({ open, onClose, existing }: { open: boolean; onClose(): void; existing: string[] }) {
  const { project } = useProjectContext();
  const [locale, setLocale] = useState('');
  const create = useMutation({
    mutationFn: () =>
      post(`/projects/${project.slug}/documents`, {
        key: `strings/${locale}`,
        kind: 'strings',
        title: locale,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['documents', project.slug] });
      setLocale('');
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add a language"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!locale || existing.includes(locale)}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Add
          </Button>
        </>
      }
    >
      <Field label="Locale" hint='BCP 47, e.g. "fr", "pt-BR", "ar"'>
        <Input
          autoFocus
          value={locale}
          onChange={(e) => setLocale(e.target.value.trim())}
          className="font-mono"
        />
      </Field>
      {create.error ? <p className="mt-2 text-sm text-red-600">{errorMessage(create.error)}</p> : null}
    </Dialog>
  );
}
