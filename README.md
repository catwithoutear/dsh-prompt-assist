# Prompt Preview & History

A DSH plugin that suggests the next user prompt after a completed answer, and lets you browse and restore recent prompts with ↑/↓ — inside the native composer.

[中文文档](README_ZH.md)

## Features

- **Next-prompt preview.** After a turn completes with a real answer, the empty composer shows one short next message drafted from the user's perspective, using the session's current model.
- **Suggest, never send.** The suggestion is only a preview. Tab fills it into the draft; Esc ignores it. Nothing is sent automatically and the draft is never written in the background.
- **Reuse without re-calling the model.** A suggestion generated for a completed turn is cached. Typing, paste, IME composition, and history browsing only hide it; clearing the draft restores the same suggestion without another model call.
- **Prompt history.** ↑ walks back through recent prompts, ↓ walks forward, and going past the newest entry restores the original draft. A typed prefix filters the history, and editing exits history mode.
- **Native layout.** The preview occupies the composer's existing overlay seat. Only a ready suggestion expands the input card, so the editor keeps focus, caret, and IME behavior; without a suggestion the composer looks untouched, and while a suggestion is being generated the native placeholder stays visible.

## Compatibility

- DSH `>=0.2.1-rc.2 <0.3.0`, Node.js >= 22.
- Disable `dsh-prompt-history` before enabling this plugin. Running both creates duplicate keyboard listeners and overlapping previews.
- No extra model configuration. Preview generation uses the session's selected model and consumes that model's quota.

## Installation

Install from the DSH sidebar: **Plugins → Add plugin → Install third-party plugin**, then enter:

```text
https://github.com/catwithoutear/dsh-prompt-assist.git
```

You can also install a local checkout through the plugin manager. The package name is `@catwithoutear/dsh-prompt-assist`; the display name is **Prompt Preview & History**.

To update an existing install: rebuild with `npm run build`, reinstall or re-apply the source in the plugin manager, restart DSH for Host changes, and refresh the page for client changes. Replacing an already loaded Host module requires a restart; refreshing the page alone is not enough. When upgrading from the old `@local/dsh-prompt-assist` name, remove that plugin entry first and install `@catwithoutear/dsh-prompt-assist`; do not restart DSH before the new package is installed.

## Usage

1. Wait for an answer to finish completely. When the session is idle and no input is queued, a grey suggestion appears in the visible, empty composer with the hint `Tab to accept · Esc to dismiss`.
2. Press **Tab** to copy the suggestion into the draft. It is not sent.
3. Press **Esc** to ignore the suggestion for that turn.
4. Press **↑** for an older prompt, **↓** for a newer one. Going past the newest entry restores the draft you started with. With text in the composer, history only shows entries starting with that prefix.
5. Typing, pasting, IME composition, or opening history hides the current suggestion. Clearing the draft brings a cached suggestion back.

The suggestion is hidden while the session is running, while files or images are attached, and whenever the composer is not in its plain editing state. History restores text only; attachments from earlier prompts are not recreated.

## Behavior and guarantees

- **Eligibility.** A suggestion is requested only after a `completed` turn whose final assistant message has text, is not interrupted, and contains no tool calls; the session must be idle with no queued input. Tool activity, message rendering, and focus changes do not trigger it.
- **Model choice.** The preview uses the session's `modelSelection.next` or `lastUsed`, falling back to the session request header. It never falls back to a global default and keeps the same provider and model. When available, the lowest reasoning effort is used; otherwise the session's selected effort is kept. Output is capped at 2048 tokens with a 60-second timeout.
- **Context.** Only the last 8 user and assistant text messages are sent, with roles preserved. User text is trimmed to the last 2,400 characters and assistant text to 3,200; tool output, reasoning, and system prompts are excluded.
- **Filtering.** The system prompt asks for fewer than 160 characters. Suggestions that are empty, longer than 200 characters, multiline, start with Markdown/list/role prefixes, or read like assistant chatter are discarded. Failures and empty results are not retried automatically; a timeout is reported as stale and may be retried the next time the composer becomes eligible.
- **History.** The last 200 human text messages are considered, with consecutive duplicates merged. History restores text only and is rebuilt from the session log, so it survives a page refresh.
- **Safety.** No global overlay, fixed positioning, DOM injection, chat DOM watching, or polling. The preview is a status element inside the composer overlay slot, and its layout styles are scoped to the plugin and removed with the component.

## Development

```sh
npm ci
npm run build       # regenerate lib/client.js from src/
npm test            # node:test suites
npm run check       # syntax-check src/index.js and lib/client.js
npm pack --dry-run  # inspect the distribution file list
```

Edit only the modules under `src/`. `lib/client.js` is generated by `build.mjs` and must not be edited by hand. The build is idempotent: with unchanged sources it leaves the bundle byte-for-byte identical.

## Testing

The suite contains 22 tests in three files:

- `test/core.test.js` — session folding, eligibility, sanitization, history walking, model selection, wire validation.
- `test/preview-state.test.js` — candidate caching, visibility transitions, cancellation, late results, dismissal, and retry rules.
- `test/host.test.js` — the Host service against a real Cordis context with stubbed agents, projections, and LLM stream.

The tests cover pure logic, the preview controller, and the main `predict` path. They do not cover the plugin's `apply()` registration, the React client component, native browser events, or actual layout geometry, and they do not prove the quality of real model output. Browser and visual verification are not automated.

## Project layout

```text
src/                 hand-written ESM modules
  index.js           Host entry: projection registration, Typert service, model call
  core.js            shared session fold, decisions, history, sanitization
  remote.js          Typert wire codecs and descriptor
  preview-state.js   client-side preview controller
  client-entry.js    React composer UI, slots, CSS, keyboard handling
lib/client.js        browser bundle generated by build.mjs (committed)
test/                node:test suites and Harness resolution hook
locale/              plugin title and description metadata
build.mjs            builds lib/client.js from src/
cordis.patch.yml     bundle insertion for the plugin
package.json         exports, distribution whitelist, DSH manifest
```

`AGENTS.md`, `VERIFICATION.md`, and `.changes/` are local working records. They are not part of the npm package.

## Limitations

- Suggestion quality depends on the current model. The plugin only filters obviously invalid output; it cannot guarantee a useful next prompt.
- A failed or empty generation shows no suggestion and is not retried for that turn. A timeout is treated as stale and can be requested again on the next eligible visibility change.
- Layout compatibility relies on DSH composer internals (overlay slot, editor state, and data attributes). Re-check the composer after a DSH upgrade.
- There is no settings page, side chat, clipboard feature, completion, or second history store.

## License

MIT. See [LICENSE](LICENSE).

## Credits

The prompt-history interaction and the public plugin interface were inspired by [Xiaofei-fei/dsh-prompt-history](https://github.com/Xiaofei-fei/dsh-prompt-history); this plugin is an independent implementation. The separation between a cached suggestion and its temporary visibility was informed by [openai/codex PR #23976](https://github.com/openai/codex/pull/23976), which was closed without being merged and does not describe Codex's mainline behavior.
