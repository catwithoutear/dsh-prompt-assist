#!/usr/bin/env node
/**
 * Build the verification image for every entry in verification/dsh-versions.json
 * and run its Playwright suite. The Docker build packs the plugin from this
 * checkout, so the run exercises the publishable artifact, not a source link.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function value(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const versionsDoc = JSON.parse(readFileSync(join(here, 'dsh-versions.json'), 'utf8'));
const requested = value('--dsh-version', '');
const versions = requested ? [requested] : versionsDoc.versions;
const registry = value('--registry', process.env.NPM_REGISTRY || 'https://registry.npmjs.org');
const downloadHost = value('--playwright-download-host', process.env.PLAYWRIGHT_DOWNLOAD_HOST || '');
const noBuild = process.argv.includes('--no-build');

if (versions.length === 0) {
  console.error('No DSH versions to verify; add one to verification/dsh-versions.json.');
  process.exit(2);
}

const docker = spawnSync('docker', ['--version'], { encoding: 'utf8' });
if (docker.error || docker.status !== 0) {
  console.error('Docker is required to run this verification.');
  process.exit(2);
}

const results = [];

for (const version of versions) {
  const tag = `dsh-prompt-assist-verify:${version.replace(/[^0-9A-Za-z.-]/g, '-')}`;
  const artifacts = resolve(here, 'artifacts', version);
  mkdirSync(artifacts, { recursive: true });

  if (!noBuild) {
    const buildArgs = [
      'build',
      '--file', join(here, 'Dockerfile'),
      '--build-arg', `DSH_VERSION=${version}`,
      '--build-arg', `NPM_REGISTRY=${registry}`,
      '--tag', tag,
    ];
    if (downloadHost) buildArgs.push('--build-arg', `PLAYWRIGHT_DOWNLOAD_HOST=${downloadHost}`);
    buildArgs.push('.');
    console.log(`\n=== building ${tag} ===`);
    const build = spawnSync('docker', buildArgs, { cwd: root, stdio: 'inherit' });
    if (build.status !== 0) {
      results.push({ version, ok: false, reason: 'docker build failed' });
      continue;
    }
  }

  console.log(`\n=== running ${version} ===`);
  const run = spawnSync('docker', [
    'run', '--rm', '--shm-size=2g',
    '--volume', `${artifacts}:/artifacts`,
    tag,
  ], { stdio: 'inherit' });
  results.push({
    version,
    ok: run.status === 0,
    reason: run.status === 0 ? 'passed' : `container exited ${run.status}`,
  });
}

console.log('\n=== verification summary ===');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  DSH ${result.version}  (${result.reason})`);
}
console.log(`artifacts: ${resolve(here, 'artifacts')}`);

process.exit(results.every(result => result.ok) ? 0 : 1);
