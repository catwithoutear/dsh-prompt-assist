import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'verification/check-dsh-versions.mjs');
const engines = '>=0.2.1-rc.3 <0.2.2-alpha.0 || >=0.2.2-alpha.2 <0.2.3-0';

function fixture({ range = engines, versions }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-'));
  const pkgPath = join(dir, 'package.json');
  const versionsPath = join(dir, 'dsh-versions.json');
  writeFileSync(pkgPath, JSON.stringify({ engines: { dsh: range } }));
  writeFileSync(versionsPath, JSON.stringify({ versions }));
  return { dir, pkgPath, versionsPath };
}

function check(f, extra = []) {
  return spawnSync(process.execPath, [
    script, '--offline', '--package', f.pkgPath, '--versions', f.versionsPath, ...extra,
  ], { cwd: root, encoding: 'utf8' });
}

test('version matrix accepts explicit prerelease canaries under includePrerelease', () => {
  const f = fixture({ versions: ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2'] });
  try {
    const result = check(f);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /0\.2\.2-alpha\.2/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('version matrix requires every prerelease lower bound to be listed', () => {
  const f = fixture({ versions: ['0.2.1-rc.3', '0.2.1-rc.4'] });
  try {
    const result = check(f);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /prerelease bound 0\.2\.2-alpha\.2/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('version matrix rejects an alternative below the lowest verified version', () => {
  const f = fixture({
    range: '>=0.2.1-rc.3 <0.2.2-alpha.0 || >=0.2.1-rc.2 <0.2.2-alpha.0',
    versions: ['0.2.1-rc.3'],
  });
  try {
    const result = check(f);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /lower bound 0\.2\.1-rc\.2/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('version matrix rejects an unlisted prerelease inside a broader range', () => {
  const f = fixture({
    range: '>=0.2.1-rc.3 <0.2.2-alpha.0 || >=0.2.2-alpha.2 <0.3.0-0',
    versions: ['0.2.1-rc.3', '0.2.2-alpha.1'],
  });
  try {
    const result = check(f);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /outside engines\.dsh/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('repository version matrix is internally consistent', () => {
  const result = spawnSync(process.execPath, [script, '--offline'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /0\.2\.2-alpha\.2/);
});
