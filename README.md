# Prompt Preview & History

A DSH plugin that suggests the next user prompt after a completed answer, lets you browse and restore recent prompts with ↑/↓, continues the draft you are typing, and rewrites a selected instruction into an unambiguous request — all inside the native composer.

[中文文档](README_ZH.md)

## Features

- **Next-prompt preview.** After a completed answer, the empty composer shows one short next message drafted from the user's perspective, using the session model or a configured auxiliary model.
- **Configurable auxiliary model.** Choose any provider/model already configured in DSH under **Settings → Prompt assist**. Leave it empty to follow the session model. The plugin stores no extra API keys and never silently falls back.
- **Shortcut trigger and automatic mode.** `Trigger prompt prediction` asks for the next prompt when the draft is empty and for a continuation when it is not. `Toggle automatic prompt prediction` switches the post-answer automatic suggestion on or off (on by default, persisted).
- **Remappable shortcuts.** Both commands are editable under **Settings → General → Shortcuts** with the native recorder. If a default binding conflicts, the plugin still loads and tells you to assign one manually.
- **Draft continuation.** With text in the composer, the trigger asks for a continuation at the caret. A preview panel inside the composer card shows it; Tab inserts, Esc dismisses, and nothing is sent.
- **One-click optimization.** Select text (or leave the caret collapsed to optimize the whole draft) and press **Optimize** in the composer tool row. The selected instruction is rewritten so its goal, scope and constraints are explicit, without adding requirements the user did not express. The result is previewed first and applied only on confirmation, so it can be undone. Blocking ambiguity produces questions instead of a replacement. **Settings → Prompt assist → Optimization strategy** defaults to **Faithful expand** (improve wording and make already-implied details explicit); choose **Clarify only** for minimal ambiguity fixes.
- **Suggest, never send.** Every result is a preview. Only Tab or **Apply** writes to the draft; the plugin never sends or submits.
- **Native layout.** The next-prompt preview keeps using the composer's existing overlay seat; continuation and optimization use the same card-internal preview area, below the editor and above the tool row. The editor DOM is never injected.
- **Prompt history.** ↑ walks back through recent prompts, ↓ walks forward, and going past the newest entry restores the original draft. A typed prefix filters the history.

## Compatibility

- DSH `>=0.2.1-rc.3 <0.2.2-alpha.0 || >=0.2.2-alpha.2 <0.2.3-0` (verified: `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.2-alpha.2`), Node.js >= 22. The alpha verification uses Node 24 inside Docker.
- Verified exact DSH versions are listed in [`verification/dsh-versions.json`](https://github.com/catwithoutear/dsh-prompt-assist/blob/main/verification/dsh-versions.json) and exercised by [`verification/`](https://github.com/catwithoutear/dsh-prompt-assist/blob/main/verification/README.md). The accepted range and that list must stay in sync; a newer release inside the range is not supported until its matrix run is green.
- Disable `dsh-prompt-history` before enabling this plugin. Running both creates duplicate keyboard listeners and overlapping previews.
- By default the plugin uses the session model and consumes its quota; a configured auxiliary model consumes that model's quota. The plugin adds no credentials of its own.
- Shortcuts reuse the native DSH registry and persistence. On **web**, DSH only allows `Ctrl+/`, `Ctrl+Shift+,`, and `Ctrl+Shift+.`; `Ctrl+/` belongs to the shortcut page and `Ctrl+Shift+.` to the optional inspector bundle, so the manual trigger defaults to `Ctrl+Shift+,` and the auto-toggle stays unbound (assign it under **Settings → General → Shortcuts**). Desktop is unrestricted and defaults to `Primary+Alt+J` / `Primary+Alt+K` (`Cmd+Option` on macOS).

## Installation

Install from the DSH sidebar: **Plugins → Add plugin → Install third-party plugin**, then enter:

```text
https://github.com/catwithoutear/dsh-prompt-assist.git
```

You can also install a local checkout through the plugin manager. The package name is `@catwithoutear/dsh-prompt-assist`; the display name is **Prompt Preview & History**.

To update an existing install: rebuild with `npm run build`, reinstall or re-apply the source in the plugin manager, restart DSH for Host changes, and refresh the page for client changes. Replacing an already loaded Host module requires a restart; refreshing the page alone is not enough. When upgrading from the old `@local/dsh-prompt-assist` name, remove that plugin entry first and install `@catwithoutear/dsh-prompt-assist`; do not restart DSH before the new package is installed.

## Usage

1. **Next prompt**: wait for an answer to finish. When the session is idle and no input is queued, a grey suggestion appears in the visible, empty composer with the hint `Tab to accept · Esc to dismiss`.
2. **Manual trigger**: focus the composer and press the trigger shortcut. An empty draft requests the next prompt; a non-empty draft with a collapsed caret requests a continuation at the caret.
3. **Continuation**: the result appears inside the composer card. Tab inserts it at the current caret; moving the caret or editing the draft requires a fresh trigger.
4. **Optimize**: select the text to rewrite (or keep the caret collapsed to optimize the whole draft), then press **Optimize** in the tool row:
   - `MODE: replace`: press **Apply** to replace the selection (or the whole draft) or **Cancel**;
   - `MODE: questions`: only the blocking questions are shown; edit the draft and trigger again.
5. **Automatic mode**: press the toggle shortcut or use the settings page. Automatic requests stop when it is off; manual triggers still work.
6. **History**: press ↑ for an older prompt and ↓ for a newer one. Going past the newest entry restores the draft you started with. With text in the composer, history only shows entries starting with that prefix.

While the session is running, while files or images are attached, or when the composer is not in its plain editing state, suggestions are hidden. Whole-draft optimization is unavailable while the draft contains reference chips or quoted passages; a selection that overlaps either is rejected with an explanation that stays on screen until the draft changes. Continuation is not affected by chips. History restores text only.

## Settings

**Settings → Prompt assist** uses the native settings layout:

- **Automation**: one switch for generating the next-prompt suggestion after each completed answer (on by default).
- **Auxiliary model**: a card with "Follow the session model" or a configured provider/model; after choosing a provider you can pick a specific model or keep the provider default. Changes apply immediately without reloading the plugin.
- **Optimization strategy**: **Faithful expand** is the default; it improves wording and makes already-implied detail explicit. Choose **Clarify only** for minimal ambiguity fixes. Neither mode adds goals, acceptance criteria, or technical choices the draft did not express.
- **Themes**: the settings page follows the DSH light/dark theme; the select fields keep their own stroke so they stay distinguishable from the card in either theme.
- **Shortcuts**: key badges for both commands, "Unbound" when unset, and a pointer to **Settings → General → Shortcuts**.

## Behavior and guarantees

- **Eligibility.** The next-prompt preview is requested only after a `completed` turn whose final assistant message has text, is not interrupted, and contains no tool calls; the session must be idle with no queued input. Continuation is manual-only. Optimization is button-driven and not tied to turn eligibility, but requires the plain composer state.
- **Model choice.** By default the plugin uses the session's live `modelSelection.next` or `lastUsed`; it never falls back to the session request header, so a session that started without a model and picked one later works immediately. When there is no selection at all the plugin reports that the session has no model instead of blaming the auxiliary model. A configured auxiliary route is validated before every call; an unavailable route produces an actionable error instead of a silent fallback. Next-prompt and continuation use the lowest supported reasoning effort; optimization leaves the effort to the provider.
- **Context and limits.** Next-prompt sends the last 8 user/assistant text messages (user ≤2,400 and assistant ≤3,200 characters). Continuation sends recent transcript plus the draft prefix/suffix (≤8,000 characters total) and caps output at 160 single-line characters. Optimization sends the selection (≤6,000 characters) and a small context window (≤800 characters on each side); replace output is capped at 6,000 characters and questions at 2,000. Over-limit, timeout, empty output, and malformed output all produce explicit errors.
- **Filtering.** The next-prompt system prompt and 200-character filter are unchanged. Continuation and optimization have their own validators that reject assistant chatter, UI instructions, and empty results. Optimization output must follow the `MODE:` protocol.
- **Writes and races.** Every write is checked against the draft revision: continuation also requires the caret to still be where the trigger captured it; whole-draft optimization uses the revision-guarded `insertText`, never the unguarded `setDraft`. Late results, canceled requests, and previews invalidated by editing are never written.
- **History.** The last 200 human text messages are considered, with consecutive duplicates merged; history is rebuilt from the session log and survives a page refresh.
- **Safety.** No global overlay, fixed positioning, DOM injection, chat DOM watching, or polling. The preview is a status element in a DSH slot; the Host revalidates the session, turn, model route, and input lengths, and the client cannot choose a model or change the fixed optimization contract.

## Development

```sh
npm ci
npm run build       # regenerate lib/client.js from src/
npm test            # node:test suites, currently 43 tests
npm run check       # syntax-check src/index.js and lib/client.js
npm pack --dry-run  # inspect the distribution file list
npm run verify:docker  # Docker + Playwright checks for verified DSH versions
```

Edit only the modules under `src/`. `lib/client.js` is generated by `build.mjs` and must not be edited by hand. The build is idempotent: with unchanged sources it leaves the bundle byte-for-byte identical.

## Testing

The suite contains 43 tests in four files:

- `test/core.test.js` — session folding, eligibility, sanitization, route resolution, `MODE:` parsing, history walking, wire validation.
- `test/preview-state.test.js` — candidate caching, visibility transitions, automatic/manual triggers, cancellation, late results.
- `test/draft-assist.test.js` — continuation/optimization preview state machine, single-flight, late-drop, errors, cancellation.
- `test/host.test.js` — the Host service against a real Cordis context with stubbed agents, projections, and LLM stream.

The tests cover pure logic, controllers, and the main Host paths. They do not cover the plugin's `apply()` registration, the React client components, native browser events, or actual layout geometry, and they do not prove the quality of real model output. The Docker harness in `verification/` automates the core web flows (composer, next-prompt overlay, continuation, and optimization) against a deterministic model stub; it does not cover the desktop shell or real model behavior.

## Project layout

```text
src/                 hand-written ESM modules
  index.js           Host entry: Config, projection registration, Typert service, model calls and the built-in optimization contract
  core.js            shared fold, prompt contracts, validators, route resolution
  remote.js          Typert wire codecs and descriptors
  preview-state.js   next-prompt controller (automatic/manual triggers)
  draft-assist.js    continuation/optimization preview state machine
  client-entry.js    React composer UI, settings page, shortcuts, slots, CSS
lib/client.js        browser bundle generated by build.mjs (committed)
test/                node:test suites and Harness resolution hook
verification/        Docker + Playwright deployment and UI checks; DSH support matrix
locale/              plugin title and description metadata
build.mjs            builds lib/client.js from src/
cordis.patch.yml     bundle insertion for the plugin
package.json         exports, distribution whitelist, DSH manifest
```

`AGENTS.md`, `VERIFICATION.md`, and `.changes/` are local working records. They are not part of the npm package.

## Limitations

- Suggestion and optimization quality depends on the selected model. The plugin only filters structure and obviously invalid output.
- On web only the three DSH-allowed shortcut combinations are usable, and two of them belong to official plugins (`shortcuts.open` and the optional inspector); desktop can record any combination. A conflicting default requires a manual shortcut assignment.
- The continuation/optimization preview sits inside the composer card; its layout, scrolling, and focus behavior rely on the DSH composer overlay slot and need re-checking after a DSH upgrade.
- Optimization is self-contained: it uses the plugin's built-in clarification contract and reads nothing from the environment, so the feature does not depend on installed skills.
- There is no side chat, clipboard feature, second history store, or self-built shortcut system.

## License

MIT. See [LICENSE](LICENSE).

## Credits

The prompt-history interaction and the public plugin interface were inspired by [Xiaofei-fei/dsh-prompt-history](https://github.com/Xiaofei-fei/dsh-prompt-history); this plugin is an independent implementation. The separation between a cached suggestion and its temporary visibility was informed by [openai/codex PR #23976](https://github.com/openai/codex/pull/23976), which was closed without being merged and does not describe Codex's mainline behavior.
