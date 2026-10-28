import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_PROMPT,
  CHAT_REPLY,
  PREDICT_TEXT,
  CONTINUATION_DRAFT,
  CONTINUATION_TEXT,
  OPTIMIZE_DRAFT,
  OPTIMIZE_TEXT,
} from '../fixtures/prompts.mjs';

const ARTIFACTS = process.env.ARTIFACTS_DIR || '/artifacts';
const DSH_URL = process.env.DSH_URL;
if (!DSH_URL) throw new Error('DSH_URL is required');
const SCREENS = join(ARTIFACTS, 'screens');
mkdirSync(SCREENS, { recursive: true });

test.describe.configure({ mode: 'serial' });

let context;
let page;

async function screenshot(name) {
  await page.screenshot({ path: join(SCREENS, name) });
}

async function dismissOnboarding() {
  for (let step = 0; step < 5; step += 1) {
    const next = page.getByRole('button', {
      name: /^(Continue|继续|Skip|跳过|Done|完成)$/,
    }).first();
    if (!(await next.count()) || !(await next.isVisible().catch(() => false))) return;
    await next.click();
    await page.waitForTimeout(1000);
  }
}

async function openComposer() {
  await page.goto(DSH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissOnboarding();
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await composer.waitFor({ timeout: 90_000 });
  return composer;
}

async function clearComposer(composer) {
  await composer.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'en-US',
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test('boots the packed plugin and opens an editable composer', async () => {
  const composer = await openComposer();
  await expect(page).toHaveTitle(/DeepSeek Harness/);
  await expect(composer).toBeVisible();
  await screenshot('01-composer.png');
});

test('renders the automatic next-prompt preview after a completed turn', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await composer.click();
  await page.keyboard.type(CHAT_PROMPT);
  await page.keyboard.press('Enter');

  await expect(page.getByText(CHAT_REPLY).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(PREDICT_TEXT).first()).toBeVisible({ timeout: 90_000 });
  await screenshot('02-next-prompt-overlay.png');

  const draft = (await page.locator('[data-composer-input]').first().innerText()).trim();
  expect(draft).toBe('');

  const geometry = await page.evaluate(({ predict }) => {
    const rect = element => (element ? element.getBoundingClientRect().toJSON() : null);
    const suggestion = [...document.querySelectorAll('*')].find(element =>
      element.children.length === 0 && (element.textContent ?? '').includes(predict));
    return {
      card: rect(document.querySelector('[data-composer-card]')),
      input: rect(document.querySelector('[data-composer-input]')),
      overlay: rect(document.querySelector('[data-composer-overlay]')),
      suggestion: rect(suggestion),
    };
  }, { predict: PREDICT_TEXT });

  expect(geometry.input).not.toBeNull();
  expect(geometry.overlay).not.toBeNull();
  expect(geometry.suggestion).not.toBeNull();
  expect(Math.abs(geometry.overlay.top - geometry.input.top)).toBeLessThanOrEqual(1);
});

test('shows the manual continuation preview from the web shortcut', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await clearComposer(composer);
  await page.keyboard.type(CONTINUATION_DRAFT);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press(',');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');

  await expect(page.getByText(CONTINUATION_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await screenshot('03-continuation.png');
});

test('opens the optimization preview from the composer button', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await clearComposer(composer);
  await page.keyboard.type(OPTIMIZE_DRAFT);
  await page.getByRole('button', { name: /^(Optimize|优化)$/ }).first().click();

  await expect(page.getByText(OPTIMIZE_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await screenshot('04-optimize.png');
});
