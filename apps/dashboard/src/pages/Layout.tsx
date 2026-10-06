import {
  Activity,
  ChevronLeft,
  FlaskConical,
  Languages,
  LayoutTemplate,
  Rocket,
  Settings as SettingsIcon,
  UserRound,
} from 'lucide-react';
import { createContext, type ReactNode, useContext } from 'react';
import { Link, Route, Switch, useLocation, useParams } from 'wouter';
import { EditorPage } from '../editor/EditorPage';
import { useProject } from '../lib/queries';
import type { Environment, Project, Role } from '../lib/types';
import { cx, Spinner } from '../ui';
import { Documents } from './Documents';
import { Experiments } from './Experiments';
import { Health } from './Health';
import { Logo } from './Logo';
import { Releases } from './Releases';
import { Settings } from './Settings';
import { Translations } from './Translations';

interface ProjectContextValue {
  project: Project;
  role: Role;
  environments: Environment[];
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProjectContext(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('No project');
  return value;
}

const NAV = [
  { href: '/', label: 'Screens & blocks', icon: LayoutTemplate },
  { href: '/strings', label: 'Translations', icon: Languages },
  { href: '/releases', label: 'Releases', icon: Rocket },
  { href: '/experiments', label: 'Experiments', icon: FlaskConical },
  { href: '/health', label: 'Health', icon: Activity },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const [location] = useLocation();
  const active = href === '/' ? location === '/' : location.startsWith(href);
  return (
    <Link
      href={href}
      className={cx(
        'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
        active
          ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900',
      )}
    >
      {children}
    </Link>
  );
}

export function Layout() {
  const { project: slug } = useParams<{ project: string }>();
  const query = useProject(slug);
  const [location] = useLocation();
  if (query.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="grid h-full place-items-center text-sm text-zinc-500">
        Project not found. <Link href="~/">Back to projects</Link>
      </div>
    );
  }
  const value = { project: query.data.project, role: query.data.role, environments: query.data.environments };
  const editing = location.startsWith('/edit/');
  return (
    <ProjectContext.Provider value={value}>
      {editing ? (
        <Route path="/edit/*" component={EditorPage} />
      ) : (
        <div className="flex h-full">
          <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
            <Link
              href="~/"
              className="mb-3 flex items-center gap-2 rounded-lg px-1 py-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              <ChevronLeft className="size-4" />
              <Logo size={18} />
              <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                {value.project.name}
              </span>
            </Link>
            {NAV.map(({ href, label, icon: Icon }) => (
              <NavLink key={href} href={href}>
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
            <div className="mt-auto border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <NavLink href="/profile">
                <UserRound className="size-4" />
                Profile
              </NavLink>
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-6xl p-6">
              <Switch>
                <Route path="/" component={Documents} />
                <Route path="/strings" component={Translations} />
                <Route path="/releases" component={Releases} />
                <Route path="/experiments" component={Experiments} />
                <Route path="/health" component={Health} />
                <Route path="/settings" component={Settings} />
              </Switch>
            </div>
          </main>
        </div>
      )}
    </ProjectContext.Provider>
  );
}
