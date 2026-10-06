import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folder holding the bundled Agent Skills (`<name>/SKILL.md`). */
export const skillsDir = fileURLToPath(new URL('../skills/', import.meta.url));

export interface SkillInfo {
  name: string;
  description: string;
  /** Absolute path of the skill folder. */
  dir: string;
}

/** Reads `name` and `description` from a SKILL.md's YAML frontmatter. */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const fields: Record<string, string> = {};
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

export function listSkills(): SkillInfo[] {
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
    .map((entry) => {
      const dir = join(skillsDir, entry.name);
      const meta = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      return { name: meta.name ?? entry.name, description: meta.description ?? '', dir };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The SKILL.md of one bundled skill. */
export function readSkill(name: string): string {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill)
    throw new Error(
      `Unknown skill "${name}". Available: ${listSkills()
        .map((s) => s.name)
        .join(', ')}`,
    );
  return readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
}

export interface InstallSkillsOptions {
  /** Only these skills (default: all). */
  names?: string[];
  /** Replace skills that already exist in the target. */
  overwrite?: boolean;
}

/** Copies skills into a skills folder, e.g. `.claude/skills`. */
export function installSkills(
  target: string,
  options: InstallSkillsOptions = {},
): { installed: string[]; skipped: string[] } {
  const all = listSkills();
  const unknown = (options.names ?? []).filter((n) => !all.some((s) => s.name === n));
  if (unknown.length) throw new Error(`Unknown skill${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const skill of all) {
    if (options.names && !options.names.includes(skill.name)) continue;
    const dest = join(target, skill.name);
    if (existsSync(dest) && !options.overwrite) {
      skipped.push(skill.name);
      continue;
    }
    cpSync(skill.dir, dest, { recursive: true, force: true });
    installed.push(skill.name);
  }
  return { installed, skipped };
}
