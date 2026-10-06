import { expect, type Page, test } from '@playwright/test';
import { buildManifest } from '@zyrox/protocol';
import { exampleManifestInput } from '../../../examples/components/src/manifest';

const manifest = buildManifest(exampleManifestInput);
const shots = process.env.SCREENSHOT_DIR;
const shot = async (name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});

test('first run: owner sign-up and a project', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill('Shop app');
  await expect(page.getByLabel('Slug')).toHaveValue('shop-app');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Screens & blocks' })).toBeVisible();
  await expect(page.getByText('No app manifest yet')).toBeVisible();
  const upload = await page.request.post('/api/projects/shop-app/manifests', {
    data: { manifest, label: '1.0.0' },
  });
  expect(upload.status()).toBe(201);
  await page.reload();
  await expect(page.getByText('No app manifest yet')).toHaveCount(0);
});

test('build a screen in the visual editor', async () => {
  await page.getByRole('button', { name: 'New screen' }).click();
  await page.getByLabel('Key').fill('promo');
  await page.getByLabel('Title').fill('Promo');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('screen · promo')).toBeVisible();
  // The template uses the app's screen container.
  await expect(page.getByRole('treeitem', { name: 'Screen root' })).toBeVisible();

  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.getByRole('button', { name: 'Add Text', exact: true }).click();
  await page.getByRole('tab', { name: 'Layers' }).click();
  await expect(page.getByRole('treeitem', { name: 'Text text' })).toBeVisible();
  const text = page.getByLabel('text', { exact: true });
  await text.fill('Hello Zyrox');
  await text.blur();
  await page.getByLabel('variant', { exact: true }).selectOption('title');

  // The canvas renders the draft (placeholder preview from the manifest).
  const canvas = page.frameLocator('iframe[title="Preview"]');
  await expect(canvas.getByText('Hello Zyrox')).toBeVisible();

  // Add a button and wire an action.
  await page.getByRole('treeitem', { name: 'Screen root' }).click();
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.getByRole('button', { name: 'Add Button', exact: true }).click();
  await page.getByRole('tab', { name: 'Events' }).click();
  await page.getByRole('button', { name: 'Add action' }).first().click();
  await page.getByLabel('Action', { exact: true }).selectOption('track');
  await page.getByLabel('event', { exact: true }).fill('promo_tap');
  await page.getByLabel('event', { exact: true }).blur();

  // Selecting in the canvas selects in the editor.
  await canvas.getByText('Hello Zyrox').click();
  await page.getByRole('tab', { name: 'Layers' }).click();
  await expect(page.getByRole('treeitem', { name: 'Text text' })).toHaveAttribute('aria-selected', 'true');

  // Undo and redo.
  await page.getByRole('button', { name: 'Undo (⌘Z)' }).click();
  await page.getByRole('button', { name: 'Redo (⇧⌘Z)' }).click();

  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByRole('button', { name: /Problems/ })).toContainText('0');
  await shot('editor');
});

test('publish, release and deliver', async () => {
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Valid against the latest app build (1.0.0)')).toBeVisible();
  await shot('publish');
  await page.getByLabel('Message').fill('First promo');
  await page.getByRole('button', { name: 'Publish & release to dev' }).click();
  await expect(page.getByText('Published v1 to dev')).toBeVisible();

  const project = await (await page.request.get('/api/projects/shop-app')).json();
  const dev = project.environments.find((e: { key: string }) => e.key === 'dev').publicKey;
  const bootstrap = await (
    await page.request.get('/v1/bootstrap', { headers: { authorization: `Bearer ${dev}` } })
  ).json();
  const doc = await (await page.request.get(`/v1/docs/${bootstrap.docs.promo}`)).json();
  expect(doc.root.children[0]).toMatchObject({
    type: 'Text',
    props: { text: 'Hello Zyrox', variant: 'title' },
  });
  expect(doc.root.children[1].on.press[0]).toEqual({ do: 'track', event: 'promo_tap' });

  await page.getByRole('link', { name: 'Back to documents' }).click();
  await expect(page.getByText('dev v1')).toBeVisible();
  await page.getByRole('link', { name: 'Releases' }).click();
  await expect(page.getByText('Everyone else → v1')).toBeVisible();
  await shot('releases');
});

test('the assistant edits the screen with ops that can be undone', async () => {
  await page.goto('/p/shop-app/edit/promo');
  await page.getByRole('button', { name: 'Assistant' }).click();
  await page.getByLabel('Message the assistant').fill('Add a sale badge at the top');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Added a sale badge.')).toBeVisible();
  await expect(page.getByText('✓ Add a sale badge · 1 op')).toBeVisible();
  const canvas = page.frameLocator('iframe[title="Preview"]');
  await expect(canvas.getByText('AI badge')).toBeVisible();
  await expect(page.getByText('Saved')).toBeVisible();
  const draft = await (await page.request.get('/api/projects/shop-app/documents/promo')).json();
  expect(draft.draft.content.root.children[0]).toMatchObject({ id: 'sale-badge', type: 'Badge' });
  await shot('assistant');

  await page.getByRole('button', { name: 'Undo these changes' }).click();
  await expect(canvas.getByText('AI badge')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.getByRole('link', { name: 'Back to documents' }).click();
});

test('translations, health and settings', async () => {
  await page.getByRole('link', { name: 'Translations' }).click();
  await page.getByRole('button', { name: 'Add language' }).click();
  await page.getByLabel('Locale').fill('fr');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New key').fill('promo.title');
  await page.getByRole('button', { name: 'Add key' }).click();
  await page.getByLabel('promo.title in fr').fill('Bonjour');
  await page.getByRole('button', { name: 'Publish to dev' }).click();
  await expect(page.getByText('Translations published to development')).toBeVisible();

  // Machine-translate missing keys from the default locale with the server's provider.
  await page.getByRole('button', { name: 'Add language' }).click();
  await page.getByLabel('Locale').fill('en');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('promo.title in en').fill('Welcome');
  await page.getByLabel('New key').fill('promo.cta');
  await page.getByRole('button', { name: 'Add key' }).click();
  await page.getByLabel('promo.cta in en').fill('Shop {count, plural, one {# deal} other {# deals}}');
  await page.getByRole('button', { name: 'Translate missing (1)' }).click();
  await expect(page.getByText('Filled 1 translations')).toBeVisible();
  await expect(page.getByLabel('promo.cta in fr')).toHaveValue(
    '[fr] Shop {count, plural, one {# deal} other {# deals}}',
  );
  await expect(page.getByLabel('promo.title in fr')).toHaveValue('Bonjour');
  await page.getByRole('button', { name: 'Publish to dev' }).click();
  await expect(page.getByText('Translations published to development')).toBeVisible();

  await page.getByRole('link', { name: 'Health' }).click();
  await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Access tokens' }).click();
  await page.getByLabel('Token name').fill('CI');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText("Copy it now; it won't be shown again")).toBeVisible();
  await page.getByRole('tab', { name: 'App builds' }).click();
  await expect(page.getByText('13 components · 2 actions')).toBeVisible();
  await page.getByRole('tab', { name: 'AI & agents' }).click();
  await expect(page.getByText('claude mcp add --transport http zyrox')).toBeVisible();
  await expect(page.getByText('fake-mt')).toBeVisible();
  await shot('agents');
});

test('webhooks, draft previews, export and import', async () => {
  await page.getByRole('tab', { name: 'Webhooks' }).click();
  // `.invalid` never resolves, so the test delivery fails deterministically.
  await page.getByLabel('Webhook URL').fill('https://hooks.zyrox.invalid/deploy');
  await page.getByLabel('Events').selectOption('release.*');
  await page.getByLabel('Webhook description').fill('Rebuild the site');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await expect(page.getByText('Signing secret (shown once)')).toBeVisible();
  await expect(page.getByText('release.*')).toBeVisible();
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(/^Failed: /)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(page.getByText('ping', { exact: true })).toBeVisible();
  await shot('webhooks');

  await page.getByRole('tab', { name: 'Previews & export' }).click();
  await page.getByRole('button', { name: 'Create preview token' }).click();
  await expect(page.getByText(/^Preview token, valid until/)).toBeVisible();
  await expect(page.getByText(/^zpv_/)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download export' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zyrox\.json$/);
  const file = await download.path();
  await page.getByLabel('Import file').setInputFiles(file);
  await expect(page.getByText(/^0 created · 0 updated · \d+ kept/)).toBeVisible();
  await shot('export');
});
