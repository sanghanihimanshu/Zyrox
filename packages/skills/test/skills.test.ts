import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, defineAction, defineComponent, z, zx } from '@zyrox/protocol';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  checkComponentSpec,
  componentSignature,
  designSystemRules,
  installSkills,
  listSkills,
  readSkill,
  scaffoldComponent,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));

describe('skills', () => {
  it('lists the bundled skills with frontmatter', () => {
    const skills = listSkills();
    expect(skills.map((s) => s.name)).toEqual([
      'zyrox-backend-ui',
      'zyrox-components',
      'zyrox-data',
      'zyrox-i18n',
      'zyrox-performance',
      'zyrox-releases',
      'zyrox-screens',
      'zyrox-setup',
    ]);
    for (const s of skills) {
      expect(s.description.length).toBeGreaterThan(80);
      expect(s.description.length).toBeLessThanOrEqual(1024);
      expect(readSkill(s.name)).toContain(`name: ${s.name}`);
    }
    expect(() => readSkill('nope')).toThrow(/Unknown skill/);
  });

  it('installs into a folder without overwriting by default', () => {
    const target = mkdtempSync(join(tmpdir(), 'zyrox-skills-'));
    try {
      expect(installSkills(target, { names: ['zyrox-screens'] })).toEqual({
        installed: ['zyrox-screens'],
        skipped: [],
      });
      expect(existsSync(join(target, 'zyrox-screens', 'SKILL.md'))).toBe(true);
      const again = installSkills(target);
      expect(again.skipped).toEqual(['zyrox-screens']);
      expect(again.installed).toHaveLength(7);
      expect(installSkills(target, { overwrite: true }).installed).toHaveLength(8);
      expect(() => installSkills(target, { names: ['x'] })).toThrow(/Unknown skill/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('scaffoldComponent', () => {
  it('rejects invalid specs with readable problems', () => {
    expect(
      checkComponentSpec({
        name: 'product card',
        props: {
          onPress: { type: 'string' },
          tone: { type: 'enum' },
          size: { type: 'enum', values: ['s'], default: 'm' },
        },
        bind: { prop: 'missing', event: 'change' },
      }),
    ).toEqual([
      'Name "product card" must be PascalCase, e.g. "ProductCard"',
      'Prop "onPress" is reserved (events become on<Event> handlers)',
      'Enum prop "tone" needs "values"',
      'Default of "size" must be one of its values',
      'bind.prop "missing" is not a prop',
    ]);
    expect(() => scaffoldComponent({ name: 'x' })).toThrow(/PascalCase/);
  });

  it('generates a definition whose manifest matches the spec', async () => {
    const result = scaffoldComponent({
      name: 'ProductCard',
      description: "Product tile, it's pressable",
      props: {
        title: { type: 'string', optional: false, description: 'Product name' },
        image: { type: 'image' },
        price: { type: 'number' },
        tone: { type: 'enum', values: ['default', 'promo'], default: 'default' },
      },
      events: ['press'],
      slots: ['footer'],
    });
    expect(result.files.map((f) => f.path)).toEqual([
      'src/zyrox/components/product-card/def.ts',
      'src/zyrox/components/product-card/ProductCard.tsx',
      'src/zyrox/components/product-card/ProductCard.native.tsx',
    ]);
    const def = result.files[0]!.content;
    expect(def).toContain("description: 'Product tile, it\\'s pressable',");
    expect(def).toContain("tone: z.enum(['default', 'promo']).default('default'),");
    expect(result.registration).toContain(
      "import { ProductCardDef } from './src/zyrox/components/product-card/def';",
    );

    // Evaluate the generated definition and compare with a hand-written one.
    const module = await evaluate(def);
    const expected = defineComponent({
      name: 'ProductCard',
      description: "Product tile, it's pressable",
      source: 'src/zyrox/components/product-card/ProductCard.tsx',
      props: z.object({
        title: z.string().describe('Product name'),
        image: zx.image().optional(),
        price: z.number().optional(),
        tone: z.enum(['default', 'promo']).default('default'),
      }),
      events: ['press'],
      slots: ['footer'],
    });
    expect(buildManifest({ components: [module.ProductCardDef] }).hash).toBe(
      buildManifest({ components: [expected] }).hash,
    );
  });

  it('generates web and native code that type-checks', { timeout: 60_000 }, () => {
    const out = join(here, '.scaffold');
    rmSync(out, { recursive: true, force: true });
    const specs = [
      scaffoldComponent({
        name: 'ProductCard',
        props: {
          title: { type: 'string', optional: false },
          subtitle: { type: 'multiline' },
          image: { type: 'image' },
          price: { type: 'number', default: 0 },
          tone: { type: 'enum', values: ['default', 'promo'], default: 'default' },
          featured: { type: 'boolean' },
          accent: { type: 'color' },
        },
        events: ['press', 'dismiss'],
        children: true,
        slots: ['footer', 'badge'],
        dir: 'components',
      }),
      scaffoldComponent({
        name: 'Feed',
        templates: ['item'],
        slots: ['empty'],
        events: ['endReached'],
        dir: 'components',
      }),
      ...(['string', 'multiline', 'number', 'boolean', 'enum'] as const).map((type) =>
        scaffoldComponent({
          name: `Field${type[0]!.toUpperCase()}${type.slice(1)}`,
          props: { label: { type: 'string' }, value: { type, values: ['a', 'b'] } },
          events: ['submit'],
          bind: { prop: 'value', event: 'change' },
          dir: 'components',
        }),
      ),
      scaffoldComponent({
        name: 'Rating',
        props: { value: { type: 'integer', default: 3 } },
        bind: { prop: 'value', event: 'rate' },
        platforms: ['web'],
        dir: 'components',
      }),
    ];
    const files: string[] = [];
    for (const spec of specs) {
      for (const file of spec.files) {
        const path = join(out, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
        files.push(path);
      }
    }
    const program = ts.createProgram(files, {
      strict: true,
      noUncheckedIndexedAccess: true,
      noUnusedLocals: true,
      noEmit: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
      skipLibCheck: true,
      types: [],
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => !d.file || d.file.fileName.startsWith(out))
      .map((d) => {
        const where = d.file
          ? `${d.file.fileName.slice(out.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
          : '';
        return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
      });
    expect(diagnostics).toEqual([]);
    expect(readFileSync(join(out, 'components/feed/Feed.tsx'), 'utf8')).toContain(
      'props.templates.item(item, index)',
    );
    rmSync(out, { recursive: true, force: true });
  });
});

describe('designSystemRules', () => {
  const manifest = buildManifest({
    components: [
      defineComponent({
        name: 'Button',
        description: 'A pressable button.',
        source: 'src/ui/Button.tsx',
        props: z.object({ label: z.string(), variant: z.enum(['primary', 'ghost']).default('primary') }),
        events: ['press'],
      }),
      defineComponent({
        name: 'TextField',
        props: z.object({ value: z.string().default(''), hint: zx.multiline().optional() }),
        events: { change: z.string() },
        bind: { prop: 'value', event: 'change' },
      }),
    ],
    actions: [
      defineAction({
        name: 'addToCart',
        description: 'Adds a product to the cart.',
        args: z.object({ productId: z.string(), qty: z.number().int().default(1) }),
      }),
    ],
    motions: ['fade'],
    transitions: ['slide'],
    tokens: { color: { primary: '#4f46e5' } },
  });

  it('renders signatures', () => {
    expect(componentSignature('Button', manifest.components.Button!)).toBe(
      'Button(label: string, variant?: "primary" | "ghost" = "primary") events: press',
    );
    expect(componentSignature('TextField', manifest.components.TextField!)).toBe(
      'TextField(value?: string = "", hint?: string (multiline)) events: change: string bind: value ⇄ change',
    );
  });

  it('documents components, tokens, actions and motion', () => {
    const md = designSystemRules(manifest, { project: 'Shop', label: '3.5.0', usage: { TextField: 2 } });
    expect(md).toMatch(/^# Shop design system rules \(Zyrox\)/);
    expect(md).toContain(`\`${manifest.hash}\` (3.5.0)`);
    // Most used first.
    expect(md.indexOf('### TextField')).toBeLessThan(md.indexOf('### Button'));
    expect(md).toContain('Code: `src/ui/Button.tsx` · Used in 0 screens');
    expect(md).toContain('| `variant` | "primary" \\| "ghost" | `"primary"` |  |');
    expect(md).toContain('| `label` | string | required |  |');
    expect(md).toContain('Two-way binding: `"bind": "<state path>"` (value ⇄ change)');
    expect(md).toContain('| `primary` | `#4f46e5` |');
    expect(md).toContain(
      '- `addToCart` { productId: string, qty?: integer = 1 } — Adds a product to the cart.',
    );
    expect(md).toContain('Screen transitions (`navigate.transition`): slide');
    expect(designSystemRules(undefined)).toContain('No app manifest has been uploaded yet');
  });
});

async function evaluate(code: string): Promise<Record<string, any>> {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const protocol = await import('@zyrox/protocol');
  const exports: Record<string, any> = {};
  new Function('require', 'exports', js)((id: string) => {
    if (id !== '@zyrox/react') throw new Error(`Unexpected import ${id}`);
    return protocol;
  }, exports);
  return exports;
}
