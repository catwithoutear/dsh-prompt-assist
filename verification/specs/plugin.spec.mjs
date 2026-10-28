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
  QUESTIONS_DRAFT,
  QUESTIONS_TEXT,
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

async function setComposerText(composer, text) {
  await composer.click();
  await expect(composer).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect(composer).toHaveText('');
  await page.keyboard.insertText(text);
  try {
    await expect(composer).toHaveText(text, { timeout: 5_000 });
  } catch {
    await composer.fill(text);
    await expect(composer).toHaveText(text);
  }
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
  await setComposerText(composer, CHAT_PROMPT);
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

async function assertInsideComposer(text) {
  const result = await page.evaluate(({ needle }) => {
    const element = [...document.querySelectorAll('*')].find(item =>
      item.children.length === 0 && (item.textContent ?? '').includes(needle));
    if (element === undefined) return { found: false };
    const card = element.closest('[data-composer-card]');
    const overlay = element.closest('[data-composer-overlay]');
    const panel = element.closest('[data-prompt-assist-draft-panel]');
    const input = card?.querySelector('[data-input-scroll]') ?? card?.querySelector('[data-composer-input]');
    const row = card?.lastElementChild;
    const rect = node => node ? node.getBoundingClientRect().toJSON() : null;
    return {
      found: true,
      inCard: card !== null,
      inOverlay: overlay !== null,
      inDock: element.closest('[data-composer-dock]') !== null,
      inPanel: panel !== null,
      panel: rect(panel),
      input: rect(input),
      row: rect(row),
    };
  }, { needle: text });
  expect(result.found).toBe(true);
  expect(result.inCard).toBe(true);
  expect(result.inOverlay).toBe(true);
  expect(result.inDock).toBe(false);
  expect(result.inPanel).toBe(true);
  expect(result.panel).not.toBeNull();
  expect(result.input).not.toBeNull();
  expect(result.row).not.toBeNull();
  expect(result.panel.top).toBeGreaterThanOrEqual(result.input.bottom - 1);
  expect(result.panel.bottom).toBeLessThanOrEqual(result.row.top + 1);
}

test('shows the manual continuation preview inside the composer card', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await setComposerText(composer, CONTINUATION_DRAFT);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press(',');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');

  await expect(page.getByText(CONTINUATION_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await assertInsideComposer(CONTINUATION_TEXT);
  await screenshot('03-continuation.png');
});

test('applies only with Apply and dismisses on Cancel', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await setComposerText(composer, OPTIMIZE_DRAFT);
  await page.getByRole('button', { name: /^(Optimize|优化)$/ }).first().click();

  await expect(page.getByText(OPTIMIZE_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await assertInsideComposer(OPTIMIZE_TEXT);
  await expect(page.getByRole('button', { name: /^(Apply|应用)$/ })).toBeVisible();
  await expect(composer).toHaveText(OPTIMIZE_DRAFT);
  await screenshot('04-optimize-replace.png');

  await page.getByRole('button', { name: /^(Apply|应用)$/ }).first().click();
  await expect(composer).toHaveText(OPTIMIZE_TEXT);
  await expect(page.locator('[data-prompt-assist-draft-panel]')).toHaveCount(0);

  await setComposerText(composer, OPTIMIZE_DRAFT);
  await page.getByRole('button', { name: /^(Optimize|优化)$/ }).first().click();
  await expect(page.getByText(OPTIMIZE_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^(Cancel|取消)$/ }).first().click();
  await expect(page.locator('[data-prompt-assist-draft-panel]')).toHaveCount(0);
  await expect(composer).toHaveText(OPTIMIZE_DRAFT);
});

test('shows clarification questions without an Apply action', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await setComposerText(composer, QUESTIONS_DRAFT);
  await page.getByRole('button', { name: /^(Optimize|优化)$/ }).first().click();

  await expect(page.getByText(QUESTIONS_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await assertInsideComposer(QUESTIONS_TEXT);
  await expect(page.locator('[data-prompt-assist-draft-panel][data-prompt-assist-optimize-mode="questions"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Apply|应用)$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Close|关闭)$/ }).first()).toBeVisible();
  await screenshot('05-optimize-questions.png');

  // The clarification card stays readable while the human edits the draft.
  await composer.click();
  await page.keyboard.press('End');
  await page.keyboard.type('补充一下');
  await expect(page.getByText(QUESTIONS_TEXT).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Apply|应用)$/ })).toHaveCount(0);
  await screenshot('06-questions-while-editing.png');

  // They must not outlive an empty draft. Type after clearing so the automatic
  // next-prompt overlay cannot hide a stale questions panel.
  await setComposerText(composer, 'x');
  await expect(page.locator('[data-prompt-assist-draft-panel]')).toHaveCount(0);

  // Close is a real action, not just a rendered label.
  await setComposerText(composer, QUESTIONS_DRAFT);
  await page.getByRole('button', { name: /^(Optimize|优化)$/ }).first().click();
  await expect(page.getByText(QUESTIONS_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^(Close|关闭)$/ }).first().click();
  await expect(page.locator('[data-prompt-assist-draft-panel]')).toHaveCount(0);
});

test('dismisses clarification questions after sending the draft', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await setComposerText(composer, QUESTIONS_DRAFT);
  await page.getByRole('button', { name: /^(Optimize|优化)$/ }).first().click();
  await expect(page.getByText(QUESTIONS_TEXT).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /^(Apply|应用)$/ })).toHaveCount(0);

  await composer.click();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /2 turns/ })).toBeVisible({ timeout: 90_000 });

  // Type after completion so a fresh next-prompt overlay cannot mask a stale panel.
  await setComposerText(composer, 'x');
  await expect(page.locator('[data-prompt-assist-draft-panel]')).toHaveCount(0);
  await screenshot('07-questions-after-send.png');
});

test('rejects a continuation with no text before the caret', async () => {
  const composer = page.locator('[data-composer-input][contenteditable="true"]').first();
  await setComposerText(composer, CONTINUATION_DRAFT);
  await page.keyboard.press('Home');
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press(',');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');

  await expect(page.getByText(/Place the caret after some draft text to continue\./)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(CONTINUATION_TEXT)).toHaveCount(0);
  await screenshot('08-no-prefix.png');
});
