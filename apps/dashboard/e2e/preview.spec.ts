import { expect, test } from '@playwright/test';
import { buildManifest } from '@wishyor/zyrox-protocol';
import productJson from '../../../examples/components/documents/product.json' with { type: 'json' };
import { exampleManifestInput } from '../../../examples/components/src/manifest';

const WEB = 'http://localhost:4173';

test('the canvas renders your real components, and devices follow edits live', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Owner may already exist from the other spec: log in or sign up.
  const signup = await page.request.post('/api/auth/signup', {
    data: { email: 'preview@example.com', password: 'password123', name: 'Pre' },
  });
  if (!signup.ok()) {
    const owner = await page.request.post('/api/auth/login', {
      data: { email: 'ada@example.com', password: 'correct horse' },
    });
    expect(owner.ok()).toBe(true);
  }
  const created = await page.request.post('/api/projects', {
    data: { name: 'Preview', slug: 'preview-demo' },
  });
  expect(created.status()).toBe(201);
  await page.request.post('/api/projects/preview-demo/manifests', {
    data: { manifest: buildManifest(exampleManifestInput), label: '1.0.0' },
  });
  await page.request.patch('/api/projects/preview-demo', { data: { previewUrl: `${WEB}/__zyrox/preview` } });
  await page.request.post('/api/projects/preview-demo/documents', {
    data: { key: 'product', kind: 'screen', content: productJson },
  });

  await page.goto('/p/preview-demo/edit/product');
  const canvas = page.frameLocator('iframe[title="Preview"]');
  // Real example components (DOM), with mock data.
  await expect(canvas.getByRole('heading', { name: 'Trail Shoe' }).first()).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Add 1 to cart' })).toBeVisible();
  // The canvas iframe is CSS-scaled to fit; Playwright's pointer coordinates ignore that scale,
  // so dispatch the click on the element itself.
  await canvas.getByRole('button', { name: 'Add 1 to cart' }).dispatchEvent('click');
  await expect(page.getByRole('treeitem', { name: 'Button add' })).toHaveAttribute('aria-selected', 'true');
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/real-canvas.png` });

  // Start a device preview and open its link as a "device".
  await page.getByRole('button', { name: 'Device' }).click();
  const link = await page.getByRole('link', { name: 'Open in your web app' }).getAttribute('href');
  expect(link).toContain('zyrox-preview=1');
  const device = await context.newPage();
  await device.goto(link!);
  await expect(device.getByText('$129.50')).toBeVisible();
  await expect(page.getByText(/1 · web/)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // Edit in the dashboard: the device updates without reloading.
  await page.getByLabel('label', { exact: true }).fill('Buy {{ state.qty }} now');
  await page.getByLabel('label', { exact: true }).blur();
  await expect(device.getByRole('button', { name: 'Buy 1 now' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Buy 1 now' })).toBeVisible();
  if (process.env.SCREENSHOT_DIR)
    await device.screenshot({ path: `${process.env.SCREENSHOT_DIR}/device.png` });
  await context.close();
});
