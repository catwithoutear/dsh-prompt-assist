# Verification harness

This directory is a release gate for the packaged plugin, not another unit-test
suite. It installs the tarball produced from this checkout into a disposable
DSH profile inside Docker, boots the real `dsh web` surface, drives the composer
with Playwright, and keeps screenshots, logs, and structured reports.

It runs only the web profile against a deterministic local model stub. It does
not call a real model, needs no API key, and does not cover the Electron shell.

## Quick start

```sh
npm ci
npm run verify:docker
```

The default command builds and runs one image per entry in
`verification/dsh-versions.json`. To verify a single version or a version that
is not in the matrix yet:

```sh
node verification/run.mjs --dsh-version 0.2.1-rc.3
```

Artifacts land in `verification/artifacts/<dsh-version>/` (gitignored):

| Path | Contents |
|---|---|
| `screens/*.png` | composer, next-prompt overlay, continuation dock, optimization preview |
| `playwright-report.json` | Playwright JSON report |
| `test-results/` | failure screenshots and traces (trace retained on failure) |
| `playwright.log` | runner output |
| `dsh-web.log` | real `dsh web` startup output, including the token URL |
| `dump-config.txt` | composed profile; the entrypoint fails if the plugin row is missing |
| `profile-package.json` / `profile-cordis.patch.yml` | installed profile and patch |
| `llm-requests.jsonl` / `llm-stats.json` | deterministic model requests and counts |
| `entry.log` | DSH, Node, npm, pnpm, and install versions |

If the host npm registry is slow, use mirrors:

```sh
node verification/run.mjs \
  --registry https://registry.npmmirror.com \
  --playwright-download-host https://npmmirror.com/mirrors/playwright
```

## What it proves

- The publishable tarball is built by the repository's own `prepack` (build,
  syntax check, and the `node:test` suites).
- The tarball installs into a fresh profile with `dsh plugin --profile web add`;
  the plugin bundle is registered in the profile and appears in
  `dsh --profile web --dump-config`.
- The web server announces its authenticated token URL; Playwright exchanges it
  and reaches an editable composer.
- After one completed assistant turn, the automatic next-prompt overlay is
  visible, and its overlay seat shares the front line with the composer
  (`overlay.top` equals `input.top` within 1px).
- The default web shortcut (`Ctrl+Shift+,`) triggers a continuation preview in
  the dock.
- The composer **Optimize** button opens the optimization preview.

## What it does not prove

- Desktop (Electron) behavior, native menus, or desktop-only shortcuts.
- Real model output quality or latency; the stub returns fixed text.
- Pixel-perfect layout across hosts. The image pins the Node major, an exact DSH
  version, an exact Playwright version, and its matching Chromium, but no visual
  baseline is committed yet.
- Every viewport, locale, or shortcut customisation.

The plugin relies on DSH composer internals (`data-composer-*`, `:has()`, and
composer slots). When DSH changes them, this suite is expected to fail and point
at the affected screenshot.

## DSH version support

Version support has two layers:

- `package.json` `engines.dsh` is the range DSH accepts at install time.
- `verification/dsh-versions.json` lists the exact versions this harness has
  actually exercised. The lowest entry must equal the lower bound of
  `engines.dsh`; `verification/check-dsh-versions.mjs` enforces that.

A DSH release inside `engines.dsh` is not considered supported merely because
the semver range accepts it. It becomes supported when its entry is added here
after a green run. Current verified versions: `0.2.1-rc.3` and `0.2.1-rc.4`.

The checker also reports published versions newer than the highest verified
version even when they are outside `engines.dsh` (for example a future
`0.3.0`). In-range releases and stable/rc releases outside the range fail the
watch job; alpha/beta canaries are reported but do not fail it.

### When DSH publishes a new version

1. The scheduled **DSH version watch** workflow runs
   `node verification/check-dsh-versions.mjs` against the npm registry. New
   versions in range fail the job and open or update a tracking issue.
2. Run the matrix for the new version:

   ```sh
   node verification/run.mjs --dsh-version <version>
   ```

3. If it passes, add the version to `verification/dsh-versions.json` and run
   `npm run verify:versions` (offline consistency check).
4. If it fails, fix the plugin or narrow `engines.dsh`; do not add the version
   until the matrix is green.
5. If the new version becomes the minimum, update `engines.dsh`, both READMEs,
   and `CHANGELOG.md`.

CI workflows:

- `.github/workflows/verify.yml` builds the matrix on changes to the plugin and
  on manual dispatch; a dispatch may name a candidate version that is not in the
  matrix yet. Each matrix cell uploads its artifacts.
- `.github/workflows/dsh-version-watch.yml` runs daily and on dispatch; it
  creates or refreshes the tracking issue when verification is needed and
  closes it once the matrix is current again.

## Implementation notes

- The Dockerfile is multi-stage: the build stage runs `npm ci` and `npm pack`;
  the runtime stage installs one exact `@deepseek-ai/dsh` version plus
  Playwright's Chromium, then installs the tarball.
- `fixtures/settings.yaml` activates `llm-pi-ai` with a local OpenAI-compatible
  stub and points `agent-default-model` at `mock-1`. `MOCK_API_KEY` is a fixture
  value; the stub ignores authentication.
- Linux first-use workspace creation calls `xdg-user-dir DOCUMENTS`; the
  entrypoint creates `~/Documents` and `~/.config/user-dirs.dirs` for that.
- The welcome notice version in the fixture is pinned to the DSH version used
  when the harness was written. The spec also dismisses the notice generically,
  so a changed notice version does not block the run.
- pnpm may print peer warnings for `@deepseek-ai/schemastery` and
  `@deepseek-ai/cordis` because the profile is isolated from the DSH install.
  The run asserts the plugin row and live RPC behavior instead of relying on a
  warning-free install.

## Failure semantics

- Docker build failure → matrix cell fails; no support claim.
- Plugin install failure → container exit 10 with the install log.
- `dsh web` URL timeout → exit 11 with the web log.
- Plugin row missing from `dsh --dump-config` → exit 12.
- Any Playwright failure → matrix cell fails; the screenshots and trace are
  retained. Artifacts are chmod'ed at container exit so the caller and
  `actions/upload-artifact` can read and remove them.
