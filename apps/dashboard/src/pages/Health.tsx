import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { useState } from 'react';
import { get } from '../lib/api';
import { Badge, Card, Empty, PageHeader, Select, Spinner } from '../ui';
import { useProjectContext } from './Layout';

interface HealthData {
  days: number;
  daily: { day: string; type: string; count: number }[];
  screens: {
    key: string;
    views: number;
    errors: number;
    errorRate: number;
    versions: { ref: string; views: number; errors: number; errorRate: number }[];
    topErrors: { kind: string; nodeId: string; message: string; count: number; ref: string }[];
  }[];
  functions: { name: string; ok: number; error: number; lastError?: string }[];
  builds: { hash: string; label: string; share: number; requests: number }[];
}

const pct = (n: number) => `${(n * 100).toFixed(n < 0.01 && n > 0 ? 2 : 1)}%`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'green' }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === 'red' ? 'text-red-600' : ''}`}>
        {value}
      </div>
    </Card>
  );
}

/** Views, error rates per version, functions and app-build adoption, from client telemetry. */
export function Health() {
  const { project, environments } = useProjectContext();
  const [env, setEnv] = useState(environments.at(-1)?.key ?? 'prod');
  const [days, setDays] = useState(7);
  const health = useQuery({
    queryKey: ['health', project.slug, env, days],
    queryFn: () => get<HealthData>(`/projects/${project.slug}/health?env=${env}&days=${days}`),
    refetchInterval: 30_000,
  });
  const data = health.data;
  const views = data?.screens.reduce((s, x) => s + x.views, 0) ?? 0;
  const errors = data?.screens.reduce((s, x) => s + x.errors, 0) ?? 0;
  const daily = new Map<string, { views: number; errors: number }>();
  for (const d of data?.daily ?? []) {
    const e = daily.get(d.day) ?? { views: 0, errors: 0 };
    if (d.type === 'screen_view') e.views += d.count;
    if (d.type === 'error') e.errors += d.count;
    daily.set(d.day, e);
  }
  const maxDaily = Math.max(1, ...[...daily.values()].map((d) => d.views));
  return (
    <>
      <PageHeader
        title="Health"
        description="From aggregated client telemetry: screen views, render/expression/action errors, remote functions and app builds."
        actions={
          <>
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
            <Select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-32"
              aria-label="Period"
            >
              <option value={1}>24 hours</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </Select>
          </>
        }
      />
      {health.isLoading ? (
        <Spinner />
      ) : !data || (!views && !data.functions.length && !data.builds.length) ? (
        <Empty icon={<Activity className="size-8" />} title="No telemetry yet">
          Apps report views and errors automatically once they load screens from this environment.
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Screen views" value={views.toLocaleString()} />
            <Stat label="Errors" value={errors.toLocaleString()} tone={errors ? 'red' : undefined} />
            <Stat
              label="Error rate"
              value={views ? pct(errors / views) : '—'}
              tone={views && errors / views > 0.01 ? 'red' : undefined}
            />
            <Stat label="App builds seen" value={String(data.builds.length)} />
          </div>
          {daily.size ? (
            <Card className="p-4">
              <div className="mb-2 text-sm font-medium">Views per day</div>
              <div className="flex h-24 items-end gap-1">
                {[...daily.entries()].map(([day, d]) => (
                  <div
                    key={day}
                    className="flex flex-1 flex-col items-center gap-1"
                    title={`${day}: ${d.views} views, ${d.errors} errors`}
                  >
                    <div
                      className="w-full rounded-t bg-indigo-500"
                      style={{ height: `${(d.views / maxDaily) * 80}px` }}
                    />
                    <span className="text-[10px] text-zinc-500">{day.slice(5)}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="px-4 py-2 font-medium">Screen</th>
                  <th className="px-4 py-2 text-right font-medium">Views</th>
                  <th className="px-4 py-2 text-right font-medium">Errors</th>
                  <th className="px-4 py-2 font-medium">By version</th>
                </tr>
              </thead>
              <tbody>
                {data.screens.map((s) => (
                  <tr key={s.key} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                    <td className="px-4 py-2 font-mono text-xs">
                      {s.key}
                      {s.topErrors.slice(0, 3).map((e) => (
                        <div
                          key={`${e.kind}${e.nodeId}${e.message}`}
                          className="mt-1 font-sans text-[11px] text-red-600"
                        >
                          {e.kind} {e.nodeId ? `#${e.nodeId}` : ''}: {e.message} ×{e.count}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{s.views.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {s.errors ? <span className="text-red-600">{s.errors}</span> : 0}{' '}
                      <span className="text-xs text-zinc-500">({pct(s.errorRate)})</span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {s.versions.map((v) => (
                          <Badge key={v.ref} tone={v.errorRate > 0.01 ? 'red' : 'zinc'} title={v.ref}>
                            {v.ref.slice(2, 9) || 'preview'} · {v.views} views · {pct(v.errorRate)}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <div className="mb-2 text-sm font-medium">Remote functions</div>
              {data.functions.length ? (
                data.functions.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center justify-between border-t border-zinc-100 py-1.5 text-xs dark:border-zinc-800"
                  >
                    <span className="font-mono">{f.name}</span>
                    <span>
                      {f.ok} ok · <span className={f.error ? 'text-red-600' : ''}>{f.error} failed</span>
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-zinc-500">No calls yet.</p>
              )}
            </Card>
            <Card className="p-4">
              <div className="mb-2 text-sm font-medium">App builds</div>
              {data.builds.map((b) => (
                <div key={b.hash} className="py-1 text-xs">
                  <div className="flex justify-between">
                    <span>{b.label || <code className="font-mono">{b.hash.slice(0, 12)}</code>}</span>
                    <span className="text-zinc-500">{pct(b.share)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: pct(b.share) }} />
                  </div>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
