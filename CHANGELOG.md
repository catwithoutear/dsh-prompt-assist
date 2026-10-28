# Changelog

All notable changes to this plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
