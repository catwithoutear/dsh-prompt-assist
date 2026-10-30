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

/**
 * Parse a CSS colour into sRGB channels. Accepts #rgb/#rrggbb/#rrggbbaa and
 * rgb()/rgba(); returns null for anything the resolver must skip.
 */
function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    const expand = digits.length <= 4 ? [...digits].map(char => char + char).join('') : digits;
    if (expand.length !== 6 && expand.length !== 8) return null;
    return {
      r: parseInt(expand.slice(0, 2), 16),
      g: parseInt(expand.slice(2, 4), 16),
      b: parseInt(expand.slice(4, 6), 16),
      a: expand.length === 8 ? parseInt(expand.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

function luminance(color) {
  const channel = value => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Flatten a translucent colour over an opaque background. */
function over(color, background) {
  const alpha = color.a ?? 1;
  return {
    r: color.r * alpha + background.r * (1 - alpha),
    g: color.g * alpha + background.g * (1 - alpha),
    b: color.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

function contrast(left, right) {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Read the painted colours of one settings select in the current theme. */
async function selectSample(selector) {
  return page.evaluate(target => {
    const element = document.querySelector(target);
    if (!element) return null;
    const card = element.closest('.dsh-pa-card');
    const style = getComputedStyle(element);
    const cardStyle = card ? getComputedStyle(card) : null;
    const shadow = style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : '';
    return {
      selectBackground: style.backgroundColor,
      selectColor: style.color,
      // The inset stroke is what separates the field from the card fill.
      selectStroke: /(rgba?\([^)]+\)|#[0-9a-f]{3,8})/i.exec(shadow)?.[0] ?? 'rgba(0, 0, 0, 0)',
      cardBackground: cardStyle ? cardStyle.backgroundColor : 'rgba(0, 0, 0, 0)',
      cardBorder: cardStyle ? cardStyle.borderTopColor : 'rgba(0, 0, 0, 0)',
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      height: element.getBoundingClientRect().height,
    };
  }, selector);
}

function analysed(sample, theme) {
  const pageBackground = parseColor(sample.bodyBackground) ?? { r: 255, g: 255, b: 255, a: 1 };
  const card = over(parseColor(sample.cardBackground) ?? { r: 0, g: 0, b: 0, a: 0 }, pageBackground);
  const select = over(parseColor(sample.selectBackground) ?? { r: 0, g: 0, b: 0, a: 0 }, card);
  const text = over(parseColor(sample.selectColor) ?? { r: 0, g: 0, b: 0, a: 1 }, select);
  const stroke = over(parseColor(sample.selectStroke) ?? { r: 0, g: 0, b: 0, a: 0 }, card);
  return { theme, card, select, text, stroke, height: sample.height,
    fillRatio: contrast(select, card), strokeRatio: contrast(stroke, card),
    textRatio: contrast(text, select) };
}

/**
 * Open Settings → Prompt assist. The settings page is reached from the account
 * menu, so probe the known triggers instead of assuming one entry point.
 */
async function openSettings() {
  await page.goto(DSH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1500);
  await dismissOnboarding();
  const section = page.getByRole('button', { name: /^(Prompt assist|提示词助手)$/ }).first();
  const triggers = [
    page.getByRole('button', { name: /^(Account menu|账户菜单)/i }).first(),
    page.getByRole('button', { name: /^(More|更多)$/ }).last(),
    page.getByRole('button', { name: /^(Settings|设置)$/ }).first(),
  ];
  for (const trigger of triggers) {
    if (!(await trigger.count()) || !(await trigger.isVisible().catch(() => false))) continue;
    await trigger.click();
    await page.waitForTimeout(600);
    if (await section.isVisible().catch(() => false)) break;
    const item = page.getByRole('menuitem', { name: /^(Settings|设置)$/ })
      .or(page.getByRole('button', { name: /^(Settings|设置)$/ })).first();
    if ((await item.count()) && (await item.isVisible().catch(() => false))) {
      await item.click();
      await page.waitForTimeout(800);
      if (await section.isVisible().catch(() => false)) break;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  await expect(section).toBeVisible({ timeout: 30_000 });
  await section.click();
  await expect(page.locator('.dsh-pa-settings')).toBeVisible({ timeout: 30_000 });
}

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

test('settings selects stay visible in light and dark themes', async () => {
  await openSettings();
  const light = analysed(await selectSample('.dsh-pa-card .dsh-pa-select'), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(600);
  const dark = analysed(await selectSample('.dsh-pa-card .dsh-pa-select'), 'dark');
  await screenshot('09-settings-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });

  // The field must not dissolve into the card, and its text must stay readable.
  // Either a distinguishable fill or a visible stroke is acceptable; the bug was
  // that the field had neither and only its label was painted.
  for (const sample of [light, dark]) {
    expect(sample.height, `${sample.theme} select height`).toBeGreaterThan(28);
    const visible = Math.max(sample.fillRatio, sample.strokeRatio);
    expect(visible, `${sample.theme} select outline contrast (fill ${sample.fillRatio.toFixed(2)}, stroke ${sample.strokeRatio.toFixed(2)})`)
      .toBeGreaterThanOrEqual(1.15);
    expect(sample.textRatio, `${sample.theme} select text contrast`).toBeGreaterThanOrEqual(4.5);
  }
  expect(luminance(dark.select)).toBeLessThan(luminance(light.select));
});
