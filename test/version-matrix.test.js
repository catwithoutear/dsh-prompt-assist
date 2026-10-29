import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const script = join(root, 'verification/check-dsh-versions.mjs');

function fixture({ engines, versions }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-'));
  const pkgPath = join(dir, 'package.json');
  const versionsPath = join(dir, 'dsh-versions.json');
  writeFileSync(pkgPath, JSON.stringify({ engines: { dsh: engines } }));
  writeFileSync(versionsPath, JSON.stringify({ versions }));
  return { dir, pkgPath, versionsPath };
}

function check(f, extra = []) {
  return spawnSync(process.execPath, [
    script, '--offline', '--package', f.pkgPath, '--versions', f.versionsPath, ...extra,
  ], { cwd: root, encoding: 'utf8' });
}

test('version matrix accepts an explicit prerelease canary range', () => {
  const f = fixture({
    engines: '>=0.2.1-rc.3 <0.3.0 || >=0.2.2-alpha.2 <0.3.0',
    versions: ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.2-alpha.2'],
  });
  try {
    const result = check(f);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /0\.2\.2-alpha\.2/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('version matrix rejects a prerelease outside the explicit comparator', () => {
  const f = fixture({
    engines: '>=0.2.1-rc.3 <0.3.0',
    versions: ['0.2.1-rc.3', '0.2.2-alpha.2'],
  });
  try {
    const result = check(f);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /outside engines\.dsh/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
