#!/usr/bin/env node
/**
 * Replace floating transitive dependencies inside the installed DSH host with the
 * exact versions the support matrix was verified against.
 *
 * DSH declares its Cordis/Schemastery stack with pre-release tilde ranges, so a
 * later alpha patch of the same version is picked up by `npm install -g` even
 * though that DSH release was tested against the earlier one. For
 * 0.2.2-alpha.2 the alpha.2 patches break agent-preset mounting and every
 * session creation fails, so the matrix pins the host back per version instead
 * of freezing the whole registry.
 *
 * Usage: node pin-dsh-deps.mjs '<json map of package name to exact version>'
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const DSH_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const MODULES = join(DSH_ROOT, 'node_modules');
const WORK = '/tmp/dsh-pins';

const spec = process.argv[2];
if (!spec) {
  console.error('usage: pin-dsh-deps.mjs <json-map>');
  process.exit(2);
}
const pins = JSON.parse(spec);
if (!pins || typeof pins !== 'object' || Array.isArray(pins)) {
  console.error('pin map must be an object');
  process.exit(2);
}
// An empty map is a valid "nothing to pin" answer (versions with stable ranges).
if (Object.keys(pins).length === 0) {
  console.log('no host packages to pin');
  process.exit(0);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

let failed = false;
for (const [name, version] of Object.entries(pins)) {
  const packed = spawnSync('npm', ['pack', `${name}@${version}`, '--pack-destination', WORK], { encoding: 'utf8' });
  if (packed.status !== 0) {
    console.error(`pin ${name}: npm pack failed\n${packed.stderr ?? ''}`);
    failed = true;
    continue;
  }
  const tarball = packed.stdout.trim().split('\n').filter(Boolean).pop();
  const out = join(WORK, name.replace(/[^0-9A-Za-z]+/g, '_'));
  mkdirSync(out, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', join(WORK, tarball), '-C', out], { encoding: 'utf8' });
  if (untar.status !== 0) {
    console.error(`pin ${name}: tar failed\n${untar.stderr ?? ''}`);
    failed = true;
    continue;
  }
  const target = join(MODULES, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(join(out, 'package'), target, { recursive: true });
  const installed = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  if (installed.version !== version) {
    console.error(`pin ${name}: expected ${version}, installed ${installed.version}`);
    failed = true;
    continue;
  }
  console.log(`pinned ${name}@${version}`);
}

process.exit(failed ? 1 : 0);
