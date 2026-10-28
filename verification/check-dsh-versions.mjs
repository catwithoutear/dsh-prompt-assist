#!/usr/bin/env node
/**
 * Check that the DSH support matrix is internally consistent and, online, that
 * no published @deepseek-ai/dsh version inside package.json engines.dsh is
 * newer than the highest verified version in verification/dsh-versions.json.
 *
 * Exit codes:
 *   0  matrix is current
 *   1  new DSH versions need verification (or listed versions are outdated)
 *   2  invalid matrix / package metadata
 *   3  registry lookup failed
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function value(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const offline = process.argv.includes('--offline');
const registry = value('--registry', process.env.DSH_NPM_REGISTRY || 'https://registry.npmjs.org');
const jsonOut = value('--json-out', '');
const summaryFile = value('--summary-file', '');
const packagePath = value('--package', resolve(root, 'package.json'));
const versionsPath = value('--versions', resolve(here, 'dsh-versions.json'));

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text).trim().replace(/^v/, ''));
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (a === null || b === null) throw new Error(`invalid version: ${String(left)} / ${String(right)}`);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta;
    } else if (x !== y) {
      return xNumeric ? -1 : yNumeric ? 1 : x < y ? -1 : 1;
    }
  }
  return 0;
}

function parseRange(text) {
  const match = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(String(text ?? '').trim());
  if (match === null || parseVersion(match[1]) === null || parseVersion(match[2]) === null) {
    throw new Error(`unsupported engines.dsh range: ${JSON.stringify(text)}; expected ">=X <Y"`);
  }
  return { min: match[1], max: match[2] };
}

function satisfies(version, range) {
  if (compareVersions(version, range.min) < 0) return false;
  if (compareVersions(version, range.max) >= 0) return false;
  const parsed = parseVersion(version);
  if (parsed.prerelease.length === 0) return true;
  // npm semver: a prerelease only matches when a comparator with the same
  // major.minor.patch carries a prerelease. Our lower bound is that comparator.
  const min = parseVersion(range.min);
  return min.prerelease.length > 0
    && parsed.major === min.major
    && parsed.minor === min.minor
    && parsed.patch === min.patch;
}

function isCanary(version) {
  return /-(?:alpha|beta)(?:[.-]|$)/i.test(version);
}

function renderSummary(result) {
  const outside = result.newerOutsideRange.map(version => `\`${version}\`${isCanary(version) ? ' (canary)' : ''}`);
  const lines = [
    '# DSH version support check',
    '',
    `- Engines: \`${result.engines}\``,
    `- Verified versions: ${result.listed.map(version => `\`${version}\``).join(', ') || '(none)'}`,
    `- Registry: ${result.registry}`,
    `- Latest published overall: ${result.latestOverall ? `\`${result.latestOverall}\`` : 'unknown'}`,
    `- Latest published in range: ${result.latestPublished ? `\`${result.latestPublished}\`` : 'unknown'}`,
    `- New versions needing verification: ${result.newVersions.map(version => `\`${version}\``).join(', ') || 'none'}`,
    `- Newer versions outside engines.dsh (review the support range): ${outside.join(', ') || 'none'}`,
    '',
  ];
  if (result.error) lines.push(`ERROR: ${result.error}`, '');
  if (result.newVersions.length > 0 || result.newerOutsideRange.some(version => !isCanary(version))) {
    lines.push(
      '## Update procedure',
      '',
      '1. Review the new DSH release notes and this plugin\'s compatibility assumptions.',
      '2. Run `npm run verify:docker -- --dsh-version <version>`.',
      '3. Add the version to `verification/dsh-versions.json` only after the matrix is green.',
      '4. If the version is outside `engines.dsh`, either extend the range deliberately or document the exclusion; do not silently drop it.',
      '5. If the version becomes the new minimum, update `package.json` `engines.dsh`, both READMEs, and `CHANGELOG.md`.',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

let status = 0;
let result = {
  checkedAt: new Date().toISOString(),
  registry: offline ? 'offline' : registry,
  engines: '',
  listed: [],
  latestPublished: null,
  latestOverall: null,
  newVersions: [],
  newerOutsideRange: [],
  missingListed: [],
  offline,
};

try {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const versionsDoc = JSON.parse(await readFile(versionsPath, 'utf8'));
  const range = parseRange(pkg.engines?.dsh);
  result.engines = pkg.engines.dsh;

  const listed = versionsDoc.versions;
  if (!Array.isArray(listed) || listed.length === 0 || listed.some(item => typeof item !== 'string')) {
    throw new Error('verification/dsh-versions.json must contain a non-empty string array in "versions"');
  }
  if (new Set(listed).size !== listed.length) throw new Error('verification/dsh-versions.json contains duplicates');
  for (let index = 1; index < listed.length; index += 1) {
    if (compareVersions(listed[index - 1], listed[index]) >= 0) {
      throw new Error('verification/dsh-versions.json versions must be unique and sorted ascending');
    }
  }
  for (const version of listed) {
    if (!satisfies(version, range)) throw new Error(`verified version ${version} is outside engines.dsh ${range.min}..${range.max}`);
  }
  if (compareVersions(listed[0], range.min) !== 0) {
    throw new Error(`engines.dsh lower bound ${range.min} must equal the lowest verified version ${listed[0]}`);
  }
  result.listed = listed;

  if (!offline) {
    const endpoint = `${registry.replace(/\/+$/, '')}/@deepseek-ai%2fdsh`;
    let data;
    try {
      const response = await fetch(endpoint, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        status = 3;
        result.error = `registry lookup failed: HTTP ${response.status} from ${endpoint}`;
      } else {
        data = await response.json();
      }
    } catch (error) {
      status = 3;
      result.error = `registry lookup failed: ${error.message}`;
    }
    if (data) {
      const published = Object.keys(data.versions ?? {}).sort(compareVersions);
      const highestListed = listed.at(-1);
      result.missingListed = listed.filter(version => !published.includes(version));
      if (result.missingListed.length > 0) {
        status = 2;
        result.error = `verified versions not published: ${result.missingListed.join(', ')}`;
      }
      result.latestOverall = published.at(-1) ?? null;
      const inRange = published.filter(version => satisfies(version, range));
      result.latestPublished = inRange.at(-1) ?? null;
      const newer = published.filter(version => compareVersions(version, highestListed) > 0);
      result.newVersions = newer.filter(version => satisfies(version, range));
      result.newerOutsideRange = newer.filter(version => !satisfies(version, range));
      if (status === 0) {
        if (result.newVersions.length > 0) status = 1;
        else if (result.newerOutsideRange.some(version => !isCanary(version))) status = 1;
      }
    }
  }
} catch (error) {
  status = status === 0 ? 2 : status;
  result.error = error.message;
}

const summary = renderSummary(result);
process.stdout.write(summary);
if (summaryFile) await writeFile(summaryFile, summary);
if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(result, null, 2)}\n`);
process.exitCode = status;
