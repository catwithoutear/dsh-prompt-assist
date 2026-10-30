# Release Policy

This file is the single place that describes how a version of
`@catwithoutear/dsh-prompt-assist` is prepared, published and documented. It
collects the rules that are already enforced by the workflows and adds the
documentation duties they imply.

## Sources Of Truth

A release is consistent only when these files agree:

| File | Role |
|---|---|
| `package.json` `version` | published version; the publish workflow refuses a tag that differs |
| `package-lock.json` root `version` | must match `package.json` |
| `CHANGELOG.md` | the release note; `[Unreleased]` becomes the new version section |
| `package.json` `engines.dsh` + `verification/dsh-versions.json` | declared and verified DSH support |
| `README.md` / `README_ZH.md` compatibility lines | must state the same DSH range and verified versions |
| git tag `v<version>` | annotated tag on the release merge commit; triggers publishing |

## Versioning

Semantic Versioning, with DSH-prerelease awareness:

- `1.3.7` — backwards-compatible fix release (`### Fixed` only).
- `1.4.0` — new user-facing capability, new setting, or new supported DSH minor.
- `2.0.0` — breaking change (renamed config keys, dropped DSH range, changed RPC or `MODE:` contract).
- Pre-releases use `-rc.N` (or `-alpha.N`/`-beta.N` for a DSH canary). `N` restarts at 1 for every new `X.Y.Z`.
- Every pre-release gets its own `CHANGELOG` section, and its content is carried forward into the final version section — the final release note must describe everything the shipped package contains, not only the delta since the last rc.

## Required Release Note Content

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Every release section must satisfy:

1. **New features are listed.** Each user-visible capability added since the previous published version appears under `### Added` (a new preview, a new setting, a new shortcut, new DSH support). A feature that lives in the shipped package but not in the release note is a documentation bug.
2. **Fixed bugs are listed.** Each user-visible defect corrected since the previous published version appears under `### Fixed`, described by the symptom the user saw, not by the internal function that changed. The `settings` dark-theme fix, for example, must say the fields were invisible in the dark theme.
3. **Every `### Changed` / `### Removed` entry states what the user must do**, or says explicitly that no action is required (for example "restart DSH and refresh the page").
4. Entries are written in English, one bullet per change, with the affected surface (composer, settings, prompt contract, verification) named.
5. An `### Upgrade note` is required when the Host half, the `Config` schema, the `MODE:` contract, the DSH range or the install layout changed; it must say exactly which steps (reinstall, restart DSH, refresh page) are needed and why a refresh alone is insufficient.
6. The section header is `## [<version>] - <YYYY-MM-DD>` using the release date.
7. The `[Unreleased]` section is reset to empty after the release; nothing already published may stay in it.

The release pull request body repeats the same information for reviewers:

> The pull request body repeats the release note: the user-visible additions
> ("新特性"), each fixed defect described as 现象 / 原因 / 影响版本 ("修复的 bug"),
> and any change plus the exact upgrade steps. Copy this skeleton:

```markdown
**New features**
- ...

**Fixed bugs**
- 现象：... / 原因：... / 影响版本：...

**Other changes and upgrade steps**
- ...
```

A release PR without both a "new features" and a "fixed bugs" list (each may be
"none" when truly empty, stated as such) is not ready to merge.

## Pre-Release Flow

A pre-release exists to let the maintainer install and exercise the package
before the final version is published.

1. Branch `chore/release-v<version>` from an up-to-date `origin/main`.
2. Bump `package.json` and `package-lock.json`; move the planned entries from `[Unreleased]` into the new section.
3. Run `npm test`, `npm run build`, `npm run check`, `npm run verify:versions`, and confirm `npm pack --dry-run --ignore-scripts` ships only the whitelisted files.
4. Open the release PR; CI runs the full DSH matrix. Merge only when every cell is green.
5. `git pull --ff-only` so the local `main` is the release merge commit, then create the annotated tag **on that commit**: `git tag -a v<version> -m "Release v<version>"` and push the tag.
6. The `Publish to npm` workflow publishes with dist-tag `next` for a version containing `-`, and `latest` otherwise. Never point `latest` at a pre-release.
7. Report back the npm `dist-tags` output, the exact shasum and the tag target commit.

## Final Release Flow

1. All features and fixes intended for the version are already merged to `main` and, when a pre-release existed, verified by the maintainer on a real install.
2. Branch `chore/release-v<version>`; bump the version and open the `[<version>]` section that carries forward every entry shipped by the preceding pre-releases **plus** anything merged after them.
3. Follow the same verification gate as a pre-release; the matrix must be green on the release commit.
4. Merge, fast-forward `main`, tag `v<version>` on the release merge commit, push.
5. Confirm the publish workflow succeeded, `dist-tags.latest` points at the new version, the tarball downloads, and the CI matrix for the release PR was green.
6. Remove the task branch, its worktree and the remote branch.

## Tag Discipline

- The tag must be created on the commit whose `package.json` carries the version. Tagging a stale checkout is the known failure mode: `Publish to npm` fails with `Tag v<version> does not match package version`.
- Annotated tags only; `git cat-file -t v<version>` must report `tag`.
- If a tag was created on the wrong commit, delete it locally and remotely, then recreate it on the correct commit. Never force-move a tag that already produced a published version.
- Tags are immutable once published. A defective release is fixed by a new patch version, never by rewriting history.

## Verification Gate

Nothing is released from a commit that has not passed:

- `npm test` and `npm run check` (also enforced by `prepack`);
- `npm run verify:docker` for every version in `verification/dsh-versions.json`, or the green CI matrix that runs exactly that;
- `npm run verify:versions` against the published DSH versions;
- manual install of the pre-release when one was produced.

`verification/` evidence and the local `VERIFICATION.md` record are supporting evidence, not a substitute for the CI matrix.

## DSH Support Changes

Adding, raising or dropping a DSH version is a release-relevant change:

- add the exact version to `verification/dsh-versions.json` only after its matrix cell is green;
- keep `engines.dsh` and the README compatibility lines in sync, and record the change under `### Changed` with the new range spelled out;
- a dropped version is a breaking change unless it was never published as supported;
- the daily `Watch DSH versions` workflow opens a tracking issue; a release must not ship while that issue is open for a version inside `engines.dsh`.

## Post-Release

- `CHANGELOG.md` `[Unreleased]` starts empty; the next change adds a fresh entry.
- `AGENTS.md` "当前版本" line is a local record and should be updated after the release.
- If the release was made from a pre-release branch chain, delete the `chore/release-*` branches locally and remotely.

## Repository Notes

- `.rules/` is ignored by the user's global gitignore. This file is force-added
  with `git add -f .rules/release-policy.md`; update it on a `docs/` branch and
  merge it through a pull request like any other tracked change.
- The enforceable half of this policy lives in the workflows:
  `.github/workflows/publish.yml` (tag/version match, dist-tag choice, matrix
  consistency) and `.github/workflows/verify.yml` (DSH matrix). When the policy
  and a workflow disagree, fix the workflow in the same pull request.
- `AGENTS.md` and `VERIFICATION.md` are local records: they may describe the
  release history, but they never authorize a release on their own.

## Guardrails

- Do not publish from a local checkout.
- Do not reuse or move a tag that already published a version.
- Do not ship a release whose notes omit the new features or the fixed bugs.
- Do not let a pre-release point `latest` at itself.
- Do not merge a release pull request while any matrix cell is red.
