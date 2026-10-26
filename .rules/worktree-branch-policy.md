# Worktree And Branch Policy

Development of this repository happens on task branches, normally in linked
worktrees. The default branch is the integration line and the control plane, not
a place to commit work.

## Default Branch

`main` is the only long-lived branch. Never modify it directly.

Allowed on `main`:

- reading and searching source
- triage and investigation
- `git fetch`, `git pull --ff-only`, tag inspection
- merging an approved pull request, branch creation, worktree management

Forbidden on `main`:

- staging or committing any change, including documentation
- applying a stash
- pushing a commit that did not arrive through a pull request
- force-pushing or deleting the branch

## Branches

Name branches with the Conventional Commit type of the change, followed by a
short kebab-case topic that names the work:

```text
feat/<topic>      new capability
fix/<topic>       corrected behavior
docs/<topic>      documentation or policy text
test/<topic>      test-only change
refactor/<topic>  behavior-preserving restructure
chore/<topic>     tooling, dependencies, maintenance
```

Pick the prefix that matches the commit type you expect to use, so the branch and
its commits read as one statement: `docs/git-workflow-policy` carries
`docs(policy): ...`.

- One branch per task. Do not mix unrelated work in one branch.
- Base a new branch on an up-to-date `origin/main`.
- When a task depends on unmerged work, base it explicitly on that branch instead
  of duplicating the change.
- Do not force-push a shared branch.

## Worktrees

Linked worktrees live under the repository-local `.worktree/` directory, and the
path mirrors the branch name:

```text
.worktree/<type>/<topic>
```

Create one with:

```bash
git fetch origin
git worktree add .worktree/<type>/<topic> -b <type>/<topic> origin/main
```

- One worktree per task branch.
- Do not reuse a dirty worktree for a different task.
- Do not run two unrelated tasks in the same worktree.
- Run the verification commands below inside the task worktree.
- `.worktree/` is ignored; do not commit it.

When the work cannot land as one reviewable patch, stack branches in order
(`a1 -> a2 -> a3`) and base each on its predecessor rather than on `main`.

## Commits

- Use a Conventional Commit subject: `docs(policy): add worktree and branch policy`.
- Keep one logical change per commit; do not mix unrelated formatting or refactors.
- Keep test changes with the change they support; do not add test-only churn to an
  unrelated commit.
- The commit author is the person who ran the work; do not rewrite authorship.

## Integration

- Sync with `origin/main` before requesting merge and resolve conflicts on the
  task branch. Never resolve them by pushing to `main`.
- Merge only through a pull request, and only after the verification below passes.
- The pull request description states the scope, the verification commands run,
  and any operational step that was not verified (for example a DSH restart).
- Do not merge your own pull request without the stated verification evidence.
- After merge, delete the branch and remove its worktree:

```bash
git worktree remove .worktree/<type>/<topic>
git branch -d <type>/<topic>
git worktree prune
```

## Verification

Run these inside the task worktree before requesting merge:

```bash
npm test
npm run check
npm run build
git diff --exit-code -- lib/client.js
git diff --check
```

- `npm run build` regenerates `lib/client.js`; the diff check fails when the
  committed bundle is stale.
- This repository has no CI merge gate. The commands above are the merge gate;
  a green local run is not review coverage.
- Review the diff in the scope the task claims before merging.

## Repository Notes

- `.rules/`, `AGENTS.md`, `VERIFICATION.md`, and `.changes/` are local records
  ignored by the user's global gitignore or the repository `.gitignore`. This
  policy file is force-added with
  `git add -f .rules/worktree-branch-policy.md`; update it on a `docs/` branch
  and merge it through a pull request like any other tracked change.
- `main` is protected on GitHub: pull requests are required, direct pushes and
  force pushes are blocked, and the rule applies to administrators too. Do not
  disable or bypass the protection to land a change.
- Package identity, version, and entry-point changes update `package.json`,
  `package-lock.json`, `CHANGELOG.md`, and the local `AGENTS.md`; they still go
  through a branch and a pull request.
- Reinstalling the plugin and restarting DSH is operational verification, not a
  substitute for the pull request gate.

## Guardrails

- Do not implement a new task directly in the main checkout when a linked
  worktree should be used.
- Do not leave a finished worktree behind. Stale worktrees hide drift and
  mislead later sessions; prune them when the branch is merged or abandoned.
- Do not treat a green verification run as review coverage.
- Do not weaken branch protection to avoid the pull request flow.
