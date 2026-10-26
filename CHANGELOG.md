# Changelog

All notable changes to this plugin are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
