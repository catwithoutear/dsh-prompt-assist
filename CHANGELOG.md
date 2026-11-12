# Changelog

All notable changes to this plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Disabling or enabling the plugin applies to the Host immediately, without a restart. After an upgrade the plugin manager reports whether the new package can be applied or needs a process restart; follow that result, then refresh the page so the composer, session header and settings load the new code. Verified on the web host: disabling stops predictions while turns keep working, and enabling plus a refresh restores them.

## [1.3.9] - 2026-11-11

The next-prompt suggestion becomes configurable: pick how it reasons about the conversation, how it is worded, and let each session choose its own pair.

### Added

- **Configurable next-prompt guidance and style.** The prediction prompt is assembled from a fixed head, one guidance block, one style block and a fixed tail. Four guidance entries (natural continuation, challenge, alternative path, next action) and two styles (concise, precise) ship as copyable starting points; with the default selection the prompt is byte-identical to 1.3.8.
- **Custom guidance and style entries.** Guidance and style are the same kind of editable fragment: copy a built-in entry or create one, edit its name, description and generation instruction, reference `{{last_user_message}}`, `{{last_assistant_answer}}` or `{{recent_context}}`, then enable, disable or delete it. Up to 20 entries, instruction ≤4,000 characters.
- **Settings section for the next prompt.** Two selectors plus an entry list and editor under **Settings → Prompt assist**; switching a selection drops the stale candidate without a model request, an unusable selection stops generation with a message, and an entry that is in use cannot be deleted until another one is selected.
- **Per-session prompt strategy.** Each session can pick its own guidance and style in the session header; sessions without an override follow the global setting. The choice is stored in the profile settings document (up to 100 entries, pruned by the last change; verified across a page reload, a real restart is not verified yet), and a stale override falls back to the global value with a visible marker instead of blocking generation.

### Changed

- The next-prompt selection resolves as session override → global → built-in seed, independently per axis, and the Host cache key carries the resulting entry identity so sessions with different choices never share a candidate. Existing profiles need no action: unset selections fall back to the built-in entries and produce the same prompt as 1.3.8.
- Next-prompt generation resolves the selection before routing and refuses invalid entries instead of falling back to the default prompt. No action required; a broken global selection now shows an explanatory message rather than a generic failure.
- The verification harness pins the host Cordis/Schemastery stack per DSH version (`verification/dsh-versions.json` → `pins`). No action required for users; see the verification note below.

### Upgrade note

Reinstall the plugin package and restart DSH: the Host half gained four `Config` fields (`directionId`, `styleId`, `fragments`, `sessionOverrides`) and the new settings cannot be written against the previous Host. Refresh the browser page after the restart for the client half — a page refresh alone cannot load the new Host code or schema.

### Verification

- Unit tests cover the byte-compatible default prompt, guidance/style overrides, variable pointers and the attached-content budget, fragment resolution, the cache key, mid-stream configuration changes and per-session override resolution (103 tests).
- The Playwright suite covers the new settings selectors, the custom-entry manager and the session header selectors (choice reaches the model, persists across a reload and returns to the global setting); the full Docker matrix (`0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.2-alpha.2`) passes.
- `0.2.2-alpha.2` declares pre-release ranges for its host dependencies that resolve to later alpha patches and break agent-preset mounting; the matrix installs the versions that release was verified against. This is a host-install regression, not a plugin defect.

Versioning: this release ships new capabilities and settings; the maintainer chose the patch version 1.3.9 instead of the minor bump required by the release policy.

## [1.3.8] - 2026-11-03

Optimization in a brand-new session works again. Two separate defects stacked up: the request cursor and the model route.

### Fixed

- **Optimization no longer fails in a session that has not sent its first message.** The first draft could not be optimized at all. Two defects stacked: the draft carried the session's initial `endSeq` of `-1`, which the request schema rejects, so the gateway refused the call before any model request was made and the panel said "the model request failed"; and once that was fixed, a session that had not recorded a request header yet had no `modelSelection`, so the panel said "this session has no model yet" even though the composer showed the model it would use. The cursor is now normalised before it leaves the client and compared the same way on the host, and route resolution falls back to the deployment default model — the model the composer displays — after the plugin's own configured route and the session's live selection.
- A call the gateway or transport rejects no longer reports itself as "the model request failed". It says the request never reached the model, which is what actually happened.

### Verification

- The browser suite runs the first-draft case on DSH `0.2.2-alpha.2`; unit tests cover the cursor clamp, the rejected call, the default-model route, and every route-resolution call site.
- Confirmed on a real desktop profile: the first draft of a new session now returns a preview instead of an error.

## [1.3.8-rc.2] - 2026-11-02

### Fixed

- Optimization works in a session that has not sent a message yet and shows its model only as the deployment default. A session records `modelSelection` only when a request header is written, so before the first turn the projection is empty and the request was rejected with "this session has no model yet". Route resolution now falls back to the `agentDefaultModel` service — the same model the composer displays — after the plugin's own configured route and the session's live selection.


## [1.3.8-rc.1] - 2026-11-02

### Fixed

- Optimizing the first draft of a session that has not finished a turn yet no longer fails with a misleading "model request failed". The projection reports `endSeq: -1` before the first turn ends, while the request codec only accepts a non-negative cursor, so the gateway rejected the call before any model request was made. The cursor is now normalised before it leaves the client and compared the same way on the host, and a call that never reached the model reports "request rejected" instead of "the model request failed".


## [1.3.7] - 2026-10-30

### Fixed

- **Optimization no longer offers an Apply it cannot deliver when the draft quotes the transcript.** Selecting text in an assistant reply and pressing **Quote text** inserts an inline quote node; the previous range check only looked at `@` reference chips, so the request went out, an **Apply** button appeared, and applying it failed with "content changed". The check now also reads the editor DOM — the only signal for quotes, because the host publishes no quote projection — and refuses before calling the model. A refusal, and a write that fails for any other reason, now stays on screen until the draft changes instead of disappearing after a moment.
- The Prompt assist settings page is readable in the dark theme: select fields no longer share their card's fill without a border (they take the module fill plus a hairline stroke), the dropdown chevron is more opaque, and the "configuration unavailable" hint has a real style.

### Verification

- Optimization now refuses both a whole-draft request and a selection that covers the transcript quote, without calling the model; the browser suite covers both on DSH `0.2.2-alpha.2` and skips them on hosts without the **Quote text** action (`0.2.1-rc.3`, `0.2.1-rc.4`).
- The settings page is checked in both themes by measuring painted contrast and keeping a dark-theme screenshot.

## [1.3.6] - 2026-10-29

### Fixed

- A session that started without a model and had one selected later no longer fails optimization with "auxiliary model unavailable". Route resolution now trusts only the live `modelSelection` and never substitutes the session request header, which reflects the model the session started with rather than the current one. "No model selected" and "model unavailable" also have separate messages.

## [1.3.6-rc.3] - 2026-10-29

### Changed

- Added explicit DSH `0.2.2-alpha.2` support: `engines.dsh` now uses `>=0.2.1-rc.3 <0.2.2-alpha.0 || >=0.2.2-alpha.2 <0.2.3-0` under DSH's include-prerelease engine check; the verification matrix runs the version, and `check-dsh-versions` understands multi-range engines, prerelease lower bounds and per-version Node images. The harness selects Node 24 for the alpha cell and Node 22 for the rc cells; the protocol and schemastery ranges accept the alpha packages.

## [1.3.6-rc.2] - 2026-10-28

### Changed

- Continuation requests now use a completion-style prompt that quotes the unfinished draft, marks the caret, and includes examples of user-voice continuations. The prompt explicitly forbids answering the draft.
- Optimization strategy is configurable under **Settings → Prompt assist**: `expand` is the default and improves wording and makes already-implied detail explicit; `clarify` keeps the minimal ambiguity contract. Neither adds unstated goals, acceptance criteria, or technical choices.

## [1.3.6-rc.1] - 2026-10-28

### Changed

- Continuation and optimization previews now render inside the composer card (below the editor, above the tool row) instead of the ambient dock row shared with the context/token status meter. `MODE: questions` is presented as a distinct clarification panel with a Close action and no Apply action.
- The continuation prompt now explicitly frames the model as the human writer, forbids answering as the assistant, and the client rejects a continuation request when the caret has no text before it.

### Added

- Docker + Playwright verification harness (`verification/`): installs the packed tarball into a real DSH web host, then checks composer boot, the automatic next-prompt overlay geometry, the continuation shortcut, and both optimization preview modes against a deterministic local model stub. Screenshots, reports, profile/config dumps, and model request logs are retained.
- Explicit verified-DSH-version support: `verification/dsh-versions.json` lists the exact versions exercised by the matrix; `verify:versions` enforces consistency with `engines.dsh`; CI runs the matrix; a daily watcher reports new releases and opens a tracking issue when verification is needed; the publish workflow rejects an inconsistent matrix.

## [1.3.5] - 2026-10-28

### Changed

- One-click optimization no longer depends on an environment-provided skill. The clarifying contract now ships with the plugin (`OPTIMIZE_GUIDE` + `OPTIMIZE_CONTRACT`): preserve intent without adding requirements, resolve ambiguity from the draft before asking, fill in only what the draft determines, ask only about blocking ambiguity and unresolved conflicts, keep action authority and modifier strength, avoid AI boilerplate, and audit both directions before answering. The feature no longer depends on what is installed in the environment.
- The Host no longer injects `skills` or `workingDirectory`; `optimize` reads no skill body at runtime and can no longer return `skill-unavailable`.
- The button tooltip, error strings, package and locale metadata, and READMEs now describe the rewriting behavior instead of naming a `/clarify` skill. The `skill-unavailable` wire reason and its translations were removed.

### Upgrade note

- The Host dependency list and the optimization prompt changed. Reinstall or re-apply the bundle, restart DSH for the Host half, and refresh the page for the client half; refreshing alone does not replace the loaded Host module. Until the restart, optimization against the old Host can only report a generic failure.

## [1.3.4] - 2026-10-27

### Fixed

- Inject the plugin stylesheet from `apply()` instead of rendering it inside the composer overlay. Previously the CSS only existed while the composer overlay was mounted, so opening **Settings → Prompt assist** without a composer left the section as unstyled native controls.

## [1.3.3] - 2026-10-27

### Changed

- **Breaking:** the shortcut command ids now match the package namespace: `dsh-prompt-assist.predict` and `dsh-prompt-assist.toggle-auto` (previously `local-prompt-assist.*`). Bindings customized under the old ids no longer apply; reassign them under **Settings → General → Shortcuts**. The plugin's internal locale namespace, slot ids and projection/service key are unchanged.

## [1.3.2] - 2026-10-27

### Fixed

- Client shortcut defaults no longer collide with DSH's own commands on any runtime/platform pair. The shortcut registry validates every pair at registration time, and a conflicting default is thrown from the other plugin's own registration, which could fail that plugin's client entry and reject the whole Web boot audit. This plugin now reserves only bindings that are free across the built-in command set and the official optional inspector:
  - `local-prompt-assist.predict`: `Primary+Alt+J` on desktop; `Primary+Shift+,` (web `Ctrl+Shift+,`) on Web.
  - `local-prompt-assist.toggle-auto`: `Primary+Alt+K` on desktop; unbound on Web (the two other Web-legal defaults already belong to `shortcuts.open` and the inspector; assign a binding under **Settings → General → Shortcuts**).
- `@deepseek-ai/dsh-typert-protocol` moved from `peerDependencies` to `dependencies` (`^0.2.1-rc.3`). Profiles that still carry a stale hoisted `@deepseek-ai/*` tree (for example `~/.dsh/profiles/node_modules` from an older global CLI install) shadowed the Host's protocol package; the plugin then imported an older protocol whose `Remote()` decorator rejects the `resources` option and its Host half failed to import. The documented reason for the dependency placement is in `AGENTS.md`.

### Changed

- **Settings page redesigned** to match the native DSH settings layout: grouped sections with uppercase group titles, a hairline-separated switch row, an auxiliary-model card with themed selects and a "use the session model" reset link, and shortcut rows rendered as key badges ("Unbound" when a command has no default). No new strings are exposed outside the existing zh/en dictionaries.

- `engines.dsh` raised to `>=0.2.1-rc.3` to match the protocol dependency floor.

### Upgrade note

- Rerun `npm run build` from a checkout and reinstall/update the plugin bundle so the new dependency is fetched, then restart DSH (Host and client code both changed).

## [1.3.1] - 2026-10-27

### Changed

- Version-only release (no plugin code changes); npm publishing moved to GitHub Actions OIDC Trusted Publishing.

## [1.3.0] - 2026-10-26

### Added

- Configurable auxiliary model for next-prompt previews, draft continuation and `/clarify` optimization. Empty configuration keeps using the session model; no extra credentials are introduced.
- Shortcut commands `local-prompt-assist.predict` (manual trigger; next prompt on an empty draft, continuation otherwise) and `local-prompt-assist.toggle-auto` (automatic preview on/off). Both are remappable through the native DSH shortcut settings; conflicting defaults degrade to unbound instead of breaking the plugin.
- Manual draft continuation: a trigger asks for text at the caret, a row below the composer previews it, Tab inserts and Esc dismisses. Edits and caret movement invalidate the preview.
- `/clarify`-based one-click optimization for a selected instruction (or the whole draft when there is no selection). Results follow a `MODE: replace` / `MODE: questions` protocol, are previewed before applying, and can be undone. The skill body is read at runtime; a missing skill is reported instead of silently falling back to a generic rewrite.
- Settings page **Settings → Prompt assist** with the automatic-prediction toggle, auxiliary model picker and shortcut reference. The new fields are volatile, so changes apply without reloading the plugin.

### Changed

- `apply(ctx, config)` now declares a Schemastery `Config` and registers the additional Typert methods `continueDraft`, `optimize` and `listModels`.
- The client bundle injects the native shortcut and settings services; `build.mjs` now includes `src/draft-assist.js`.
- The plugin description, READMEs, and AGENTS notes now cover the settings page, shortcuts and the new draft flows.

### Compatibility

- DSH `>=0.2.1-rc.2 <0.3.0`; Node.js >= 22. A new peer dependency on `@deepseek-ai/schemastery ^3.18.0` is provided by DSH.
- Host changes require a DSH restart; client changes require a page refresh. Existing previews, history and remote `predict` request/result shapes remain compatible.
- On web + Linux, DSH restricts editable shortcuts to `Ctrl+/`, `Ctrl+Shift+,` and `Ctrl+Shift+.`; the plugin defaults to the latter two for trigger/toggle, while desktop defaults to `Primary+Alt+J` / `Primary+Alt+K` (`Cmd+Option` on macOS).

## [1.2.0] - 2026-10-26

### Changed

- Rename the plugin package identity from `@local/dsh-prompt-assist` to `@catwithoutear/dsh-prompt-assist`. The Cordis bundle entry, client loader id, Typert `PACKAGE`, and remote descriptor/contribution ids now use the new name.
- Keep the internal `localPromptAssist` projection/service namespace, slot id, display name, and behavior unchanged.
- Bump the package version to 1.2.0.

### Compatibility

- Existing installs must be reinstalled under the new package name; the old `@local` dependency and bundle entry are not aliased. Restart DSH after reinstalling, then refresh the page.
- Projection state and prompt history are preserved because the projection key did not change.

## [1.1.0] - 2026-10-26

### Changed

- Move Host and shared modules into `src/`; the generated browser bundle now lives at `lib/client.js`.
- Update package `exports`, the distribution whitelist, and the `check` script for the new layout.
- Split user documentation into an English `README.md` and a Chinese `README_ZH.md`, with matching structure and language links. Installation steps stay in both READMEs; verification evidence moved to the local `VERIFICATION.md`.
- Add repository layout, testing scope, and limitation sections to both READMEs.
- Refresh `AGENTS.md` for the new layout, commands, test paths, and the `.changes` workflow.

### Compatibility

- Plugin behavior, package name, display name, DSH manifest, interactions, and model policy are unchanged.
- An existing installation that links to this checkout needs a DSH restart to load the Host module from its new path, and a page refresh to load the client bundle from `lib/client.js`.

## [1.0.2] - 2026-10-20

- Restore a cached suggestion after the draft is cleared, without another model call.
- Treat a canceled Host request as retryable instead of a permanent negative cache.
- Add the shared preview-state controller and integration coverage for the composer controller.

## [1.0.1] - 2026-10-20

- Fix the preview overlapping the native placeholder and clipping multiline suggestions.
- Expand the composer card only when a ready suggestion is shown; keep the native editor for focus and input.

## [1.0.0] - 2026-10-20

- First release: next-prompt previews after completed answers and ↑/↓ prompt history.
