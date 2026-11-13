/* Built with core.js, remote.js, preview-state.js and draft-assist.js into the DSH module-loader artifact. */
function makeClient(React) {
  const h = React.createElement;
  const NS = 'local-prompt-assist';
  const SETTINGS_NS = 'dsh-prompt-assist';
  let bridge;
  const bridgeListeners = new Set();
  const notifyBridge = () => { for (const fn of bridgeListeners) fn(); };
  const bridgeSource = {
    getSnapshot: () => bridge,
    subscribe: fn => { bridgeListeners.add(fn); return () => bridgeListeners.delete(fn); },
  };
  let configForm;
  let shortcuts;
  let shortcutDegraded = false;
  const registry = new Map();
  const registryListeners = new Set();
  let registryVersion = 0;
  const notifyRegistry = () => { registryVersion += 1; for (const fn of registryListeners) fn(); };
  const registrySource = {
    getSnapshot: () => registryVersion,
    subscribe: fn => { registryListeners.add(fn); return () => registryListeners.delete(fn); },
  };
  const noopSubscribe = () => () => {};
  const EMPTY = [];
  const EMPTY_CATALOG = [];
  const EMPTY_CONFIG = { status: 'unavailable', value: undefined };
  const EMPTY_MODELS = { status: 'loading', providers: [] };
  /** Options for one axis: the built-in seeds followed by the enabled custom entries. */
  const optionRowsFor = (value, kind, translate) => {
    const rows = (kind === 'style' ? STYLES : DIRECTIONS)
      .map(item => ({ id: item.id, label: translate(`seed.${item.id}`) }));
    for (const item of Array.isArray(value?.fragments) ? value.fragments : []) {
      if (!item || item.kind !== kind || item.enabled === false
        || typeof item.id !== 'string' || !item.id) continue;
      rows.push({ id: item.id, label: typeof item.name === 'string' && item.name ? item.name : item.id });
    }
    return rows;
  };
  const fragmentLabel = (value, kind, id, translate) => {
    if (typeof id !== 'string' || !id) return '';
    return optionRowsFor(value, kind, translate).find(row => row.id === id)?.label ?? id;
  };
  const PROBLEM_KEYS = {
    'empty-name': 'fragment.error.emptyName', 'name-limit': 'fragment.error.nameLimit',
    'description-limit': 'fragment.error.descriptionLimit',
    'empty-instruction': 'fragment.error.emptyInstruction',
    'instruction-limit': 'fragment.error.instructionLimit',
    'unknown-variable': 'fragment.error.unknownVariable',
    'duplicate-fragment': 'fragment.error.duplicate', 'fragments-limit': 'fragment.error.fragmentsLimit',
    'invalid-id': 'fragment.error.invalid', 'invalid-kind': 'fragment.error.invalid',
    'invalid-fragment': 'fragment.error.invalid', 'invalid-fragments': 'fragment.error.invalid',
    'fragment-in-use': 'fragment.error.inUse',
  };
  const readAuto = () => {
    const snapshot = configForm?.getSnapshot?.();
    return snapshot?.value?.autoPredict !== false;
  };
  const sessionIdFrom = target => {
    if (!(target instanceof Element)) return undefined;
    const card = target.closest('[data-composer-card]');
    const owner = card?.querySelector('[data-prompt-assist-owner]');
    return owner?.getAttribute('data-prompt-assist-owner') || undefined;
  };

  /**
   * One session's transient notice. Informational notices fade after a moment;
   * a `sticky` notice explains a refused action and stays until the human edits,
   * dismisses it, or triggers something else, so the reason is never missed.
   */
  function createNoticeStore() {
    let value = '';
    let timer;
    const listeners = new Set();
    const publish = next => {
      if (next === value) return;
      value = next;
      for (const fn of listeners) fn();
    };
    return {
      getSnapshot: () => value,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      set(key, options = {}) {
        publish(key);
        clearTimeout(timer);
        if (options.sticky === true) return;
        timer = setTimeout(() => publish(''), 2600);
      },
      clear() { clearTimeout(timer); publish(''); },
      dispose() { clearTimeout(timer); listeners.clear(); },
    };
  }

  /**
   * True when the range touches an inline non-text node. Three sources cover the
   * host's whole vocabulary: `occurrences` (reference chips), `quotes` (when the
   * host publishes it) and the DOM walk, which is the only signal for quoted
   * passages in hosts that publish no quote projection.
   */
  function rangeHasChip(range, state) {
    if (!state) return false;
    if (rangeHasInlineNode(state.occurrences, range.start, range.end)) return true;
    if (rangeHasInlineNode(state.quotes, range.start, range.end)) return true;
    const inline = typeof state.inlineRanges === 'function' ? state.inlineRanges() : [];
    return rangeHasInlineNode(inline, range.start, range.end);
  }

  /**
   * Inline-node offsets read from the live editor DOM. The host renders every
   * non-editable inline node — a quoted passage in particular — as a
   * `contenteditable="false"` element whose text is part of the draft, and
   * publishes no projection for it. Walking the editor in document order gives
   * the same offsets the draft text uses.
   */
  function inlineRangesFromDom(card) {
    const editor = card?.querySelector('[data-composer-input]');
    if (!editor) return [];
    const entries = [];
    const visit = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { entries.push({ text: child.textContent ?? '' }); continue; }
        if (child.nodeType !== 1) continue;
        if (child.getAttribute('contenteditable') === 'false') {
          entries.push({ node: child, text: child.textContent ?? '' });
          continue;
        }
        visit(child);
      }
    };
    visit(editor);
    return inlineNodeRanges(entries);
  }

  /** True while the composer cannot accept an optimization request. */
  function composerRefusal(state) {
    if (!state) return null;
    if (state.phase !== 'plain' || state.composing || !state.draftValid) return 'error.unavailable';
    if (!state.draft) return 'error.empty-draft';
    return null;
  }

  function createSessionAssist(sessionId) {
    const notices = createNoticeStore();
    const next = createPreviewController({
      predict: (request, signal) => bridge.predict(request, signal),
      onManualError: reason => notices.set(`error.${reason}`),
    });
    const draft = createDraftAssist({
      call: (kind, request, signal) => {
        if (!bridge) return Promise.resolve({ ok: false });
        return kind === 'continuation'
          ? bridge.continueDraft(request, signal)
          : bridge.optimize(request, signal);
      },
    });
    let live = null;
    let capture = null;
    let staged = null;
    const finish = () => {
      capture = null;
      staged = null;
      draft.dismiss();
    };
    return {
      sessionId, next, draft, notices,
      bind(state) { live = state; },
      stageOptimize(span) { staged = span; },
      trigger() {
        const state = live;
        if (!state) return;
        if (state.phase !== 'plain' || state.composing) { notices.set('error.unavailable'); return; }
        if (state.draft === '') {
          if (!state.eligible) { notices.set('error.unavailable'); return; }
          if (state.fragmentInvalid) { notices.set('error.fragment-invalid', { sticky: true }); return; }
          next.trigger();
          return;
        }
        if (!state.draftValid) { notices.set('error.unavailable'); return; }
        if (state.attachments?.length) { notices.set('error.attachments'); return; }
        if (!bridge) { notices.set('error.unavailable'); return; }
        const span = state.inputActions.captureInsertion();
        if (span.start !== span.end) { notices.set('error.selection'); return; }
        if (!state.draft.slice(0, span.start).trim()) { notices.set('error.no-prefix'); return; }
        capture = { kind: 'continuation', span, rev: span.draftRev, at: span.start };
        draft.startContinuation({ sessionId, endSeq: wireEndSeq(state.endSeq),
          prefix: state.draft.slice(0, span.start), suffix: state.draft.slice(span.end) });
      },
      optimize() {
        const state = live;
        if (!state) return;
        const refusal = composerRefusal(state);
        if (refusal) { notices.set(refusal); return; }
        let span = staged;
        staged = null;
        if (!span) span = state.inputActions.captureInsertion();
        const start = span.start;
        const end = span.end;
        const whole = start === end;
        const text = whole ? state.draft : state.draft.slice(start, end);
        if (!text.trim()) { notices.set('error.empty-draft'); return; }
        // A chip or quote inside the replaced range can never be written back:
        // DSH strips inline placeholders from external text. Refuse before the
        // model call instead of offering an Apply that must fail.
        if (rangeHasChip(whole ? { start: 0, end: state.draft.length } : { start, end }, state)) {
          notices.set('error.chips', { sticky: true });
          return;
        }
        capture = { kind: 'optimize', span, rev: span.draftRev, whole, text };
        draft.startOptimize({ sessionId, endSeq: wireEndSeq(state.endSeq), text,
          before: state.draft.slice(Math.max(0, start - 800), start),
          after: state.draft.slice(end, end + 800) });
      },
      applyContinuation() { return this.apply(true); },
      apply(continuationOnly = false) {
        const state = live;
        const owned = capture;
        if (!state || !owned) return;
        const snapshot = draft.getSnapshot();
        if (snapshot.phase !== 'ready') return;
        if (continuationOnly && owned.kind !== 'continuation') return;
        if (!continuationOnly && owned.kind !== 'optimize') return;
        const actions = state.inputActions;
        if (owned.kind === 'continuation') {
          const span = actions.captureInsertion();
          if (span.draftRev !== owned.rev || span.start !== span.end || span.start !== owned.at) {
            notices.set('error.caret-moved');
            return;
          }
          if (!actions.insertText(snapshot.text, span)) { notices.set('error.stale', { sticky: true }); return; }
          finish();
          return;
        }
        const target = owned.whole
          ? { start: 0, end: state.draft.length }
          : { start: owned.span.start, end: owned.span.end };
        if (rangeHasChip(target, state)) { notices.set('error.chips', { sticky: true }); return; }
        if (state.draftRev !== owned.rev) { notices.set('error.stale', { sticky: true }); return; }
        const span = owned.whole
          ? { start: 0, end: state.draft.length, draftRev: owned.rev }
          : owned.span;
        if (!actions.insertText(snapshot.text, span)) { notices.set('error.stale', { sticky: true }); return; }
        finish();
      },
      dismissDraft() {
        capture = null;
        staged = null;
        draft.dismiss();
      },
      async toggleAuto() {
        if (!configForm) { notices.set('error.unavailable'); return; }
        const current = readAuto();
        let ok = false;
        try { ok = await configForm.set('autoPredict', !current); }
        catch { ok = false; }
        if (!ok) { notices.set('error.save-failed'); return; }
        notices.set(current ? 'notice.auto-off' : 'notice.auto-on');
        if (current) {
          next.pause();
          draft.dismiss();
        }
      },
      dispose() {
        next.dispose();
        draft.dispose();
        notices.dispose();
      },
    };
  }

  const CSS = `
[data-composer-card]:has([data-prompt-assist-ready]){
  display:grid;grid-template-columns:minmax(0,1fr)
}
[data-composer-card]:has([data-prompt-assist-ready]) > [data-composer-overlay]{
  position:relative;inset:auto;height:auto;grid-area:1 / 1;min-width:0;margin-right:4px
}
[data-composer-card]:has([data-prompt-assist-ready]) > [data-input-scroll]{
  grid-area:1 / 1;min-width:0;max-height:none;z-index:1
}
[data-composer-card]:has([data-prompt-assist-ready]) [data-composer-placeholder]{
  visibility:hidden
}
.dsh-pa-preview{
  box-sizing:border-box;min-width:0;min-height:36px;padding:4px 8px 0 14px;
  color:var(--dsw-alias-label-secondary);font:inherit;line-height:inherit;
  white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;
  pointer-events:none;user-select:none
}
.dsh-pa-text{opacity:.65}
.dsh-pa-hint{
  display:block;font-size:11px;line-height:18px;opacity:.65;text-align:right;
  white-space:normal;overflow-wrap:anywhere
}
[data-composer-card]:has([data-prompt-assist-draft]) > [data-composer-overlay]{
  position:relative;inset:auto;height:auto;order:1;width:100%;min-width:0;pointer-events:auto
}
[data-composer-card]:has([data-prompt-assist-draft]) > :last-child{order:2}
.dsh-pa-draft{
  box-sizing:border-box;display:flex;flex-direction:column;gap:4px;
  max-height:220px;overflow:auto;padding:8px 12px 4px 14px;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;
  border-top:.5px solid var(--dsw-alias-border-l1, rgba(127,127,127,.2));
  pointer-events:auto
}
.dsh-pa-draft-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-pa-draft-label{font-weight:500;color:var(--dsw-alias-label-primary)}
.dsh-pa-draft-hint{font-size:11px;opacity:.65;white-space:nowrap;text-align:right}
.dsh-pa-draft-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;opacity:.8}
.dsh-pa-draft-actions{display:flex;justify-content:flex-end;gap:6px;flex-shrink:0;padding-bottom:2px}
.dsh-pa-questions{border-left:2px solid var(--dsw-alias-state-business-primary);padding-left:12px}
.dsh-pa-button{
  box-sizing:border-box;border:1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.35));
  background:transparent;color:inherit;font:inherit;font-size:12px;line-height:20px;
  padding:0 8px;border-radius:6px;cursor:pointer
}
.dsh-pa-button:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary, currentColor)}
.dsh-pa-button:disabled{opacity:.45;cursor:default}
.dsh-pa-error{color:var(--dsw-alias-label-secondary, currentColor);opacity:.85}
.dsh-pa-settings{box-sizing:border-box;display:flex;flex-direction:column;gap:26px;max-width:720px;padding:4px 0 16px;
  color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsh-pa-group{display:flex;flex-direction:column;gap:2px}
.dsh-pa-group-title{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dsh-pa-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:14px 0;
  border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-pa-group > .dsh-pa-row:last-of-type{border-bottom:none;padding-bottom:2px}
.dsh-pa-row-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}
.dsh-pa-title{font-size:14px;line-height:20px}
.dsh-pa-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-pa-desc.dsh-pa-inline-error{color:var(--dsw-alias-state-error-primary,#d9534f)}
.dsh-pa-card{display:flex;flex-direction:column;gap:14px;padding:16px;border-radius:var(--dsw-radius-lg);
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));
  background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-settings-card-fill,transparent))}
.dsh-pa-card-head{display:flex;flex-direction:column;gap:4px}
.dsh-pa-card-title{font-size:14px;line-height:20px;font-weight:500}
.dsh-pa-field{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsh-pa-field-label{flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-pa-select-wrap{position:relative;display:inline-flex;align-items:center;min-width:220px;max-width:100%}
.dsh-pa-select{box-sizing:border-box;appearance:none;width:100%;height:36px;padding:0 34px 0 14px;border:none;
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,transparent);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.dsh-pa-card .dsh-pa-select{background:var(--dsw-alias-bg-module-platform,transparent);
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
@media (hover:hover){
  .dsh-pa-select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
}
.dsh-pa-select:disabled{opacity:.5;cursor:default}
.dsh-pa-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-pa-select-wrap::after{content:"";position:absolute;right:14px;top:50%;width:7px;height:7px;
  border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;opacity:.85;
  transform:translateY(-70%) rotate(45deg);pointer-events:none}
.dsh-pa-setting-hint{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);
  padding:10px 12px;border-radius:var(--dsw-radius-md,8px);
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));
  background:var(--dsw-alias-bg-module-platform,transparent)}
.dsh-pa-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;
  background:var(--dsw-alias-border-l2,rgba(127,127,127,.35));cursor:pointer;transition:background .16s}
.dsh-pa-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-pa-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s}
.dsh-pa-switch[aria-checked="true"]::after{transform:translateX(16px)}
.dsh-pa-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-pa-reset{align-self:flex-start;border:none;background:none;padding:0;font:inherit;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px;cursor:pointer;border-radius:4px}
.dsh-pa-reset:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-pa-keys{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.dsh-pa-kbd{font-family:inherit;font-size:12px;line-height:18px;padding:2px 6px;border-radius:6px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));
  background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-pa-kbd-unbound{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.dsh-pa-row-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-pa-button-primary{background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent;color:#fff}
.dsh-pa-entry{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;
  border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-pa-entry:last-of-type{border-bottom:none}
.dsh-pa-entry-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-pa-entry-name{font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh-pa-entry-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-pa-entry-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
.dsh-pa-editor{display:flex;flex-direction:column;gap:12px;padding-top:12px;
  border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-pa-input{box-sizing:border-box;width:min(420px,100%);height:34px;padding:0 12px;border:none;
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,transparent);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
.dsh-pa-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-pa-editor-instruction{display:flex;flex-direction:column;gap:8px}
.dsh-pa-textarea{box-sizing:border-box;width:100%;min-height:120px;padding:10px 12px;border:none;
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform,transparent);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;resize:vertical;
  box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
.dsh-pa-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-pa-vars{display:flex;flex-wrap:wrap;gap:6px}
.dsh-pa-var{font:inherit;font-size:11px;line-height:18px;padding:0 6px;border-radius:6px;cursor:pointer;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));background:transparent;
  color:var(--dsw-alias-label-secondary)}
.dsh-pa-var:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-pa-discard{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
.dsh-pa-view{box-sizing:border-box;height:100%;overflow:auto;padding:26px 32px 40px}
`;
  const STYLE_ID = 'dsh-prompt-assist-styles';
  /** Mount the plugin stylesheet once at apply time; settings render without a composer overlay. */
  function installStyles() {
    if (typeof document === 'undefined') return () => {};
    const existing = document.getElementById(STYLE_ID);
    if (existing !== null) { existing.textContent = CSS; return () => {}; }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }


  function PromptComposer(props) {
    const { useInput, useSession, useProjection, inputActions, sessionId, t } = props;
    const api = React.useSyncExternalStore(bridgeSource.subscribe, bridgeSource.getSnapshot);
    const projection = useProjection(PROJECTION);
    const draft = useInput(s => s.draft);
    const draftRev = useInput(s => s.draftRev);
    const phase = useInput(s => s.phase);
    const attachments = useInput(s => s.attachmentIds);
    const occurrences = useInput(s => s.occurrences);
    const quotes = useInput(s => s.quotes);
    const running = useSession(s => s.running);
    const removed = useSession(s => s.removed);
    const openState = useSession(s => s.openState);
    const root = React.useRef(null);
    const browse = React.useRef(null);
    const apiRef = React.useRef(api);
    apiRef.current = api;
    const assist = React.useMemo(() => createSessionAssist(sessionId), [sessionId]);
    const preview = React.useSyncExternalStore(assist.next.subscribe, assist.next.getSnapshot);
    const draftPreview = React.useSyncExternalStore(assist.draft.subscribe, assist.draft.getSnapshot);
    const notice = React.useSyncExternalStore(assist.notices.subscribe, assist.notices.getSnapshot);
    const [visible, setVisible] = React.useState(false);
    const [composing, setComposing] = React.useState(false);
    const selection = useProjection('modelSelection');
    const config = React.useSyncExternalStore(
      configForm ? configForm.subscribe : noopSubscribe,
      configForm ? configForm.getSnapshot : () => EMPTY_CONFIG,
    );
    const configValue = config?.value ?? {};
    const auto = configValue.autoPredict !== false;
    const fragmentSelection = resolveSelection(configValue, sessionId);
    const fragmentInvalid = !!fragmentSelection.error;
    // Identity only covers the selected guidance and style; the preview key stays
    // untouched so a settings change never starts a model request by itself.
    const fragmentKey = fragmentInvalid
      ? 'invalid' : fragmentIdentity(fragmentSelection.direction, fragmentSelection.style);
    const selectedRoute = selection?.next ?? selection?.lastUsed;
    const routeProvider = configValue.provider || selectedRoute?.provider || '';
    const routeModel = configValue.model || selectedRoute?.model || '';
    const key = JSON.stringify([sessionId, wireEndSeq(projection?.endSeq), routeProvider, routeModel]);
    const valid = !running && !removed && openState === 'open'
      && projection?.eligible === true && projection.openTurn === null;
    const allowed = valid && phase === 'plain' && draft === '' && !(attachments?.length);
    const draftValid = !running && !removed && openState === 'open'
      && projection?.openTurn === null && phase === 'plain' && !composing && visible;
    const live = React.useRef();
    live.current = { draft, draftRev, phase, inputActions, occurrences, quotes, attachments,
      inlineRanges: () => inlineRangesFromDom(root.current?.closest('[data-composer-card]')),
      history: projection?.history ?? EMPTY, endSeq: projection?.endSeq, allowed, composing,
      visible, key, fragmentInvalid,
      eligible: projection?.eligible === true, draftValid };
    assist.bind(live.current);

    React.useEffect(() => {
      registry.set(sessionId, assist);
      notifyRegistry();
      return () => {
        if (registry.get(sessionId) === assist) {
          registry.delete(sessionId);
          notifyRegistry();
        }
        assist.dispose();
      };
    }, [assist, sessionId]);
    React.useEffect(() => { browse.current = null; }, [sessionId]);
    React.useEffect(() => {
      if (browse.current && draft !== browse.current.last) browse.current = null;
    }, [draft]);
    React.useEffect(() => {
      const card = root.current?.closest('[data-composer-card]');
      if (!card) return;
      // This observes our owning card's visibility, never the chat DOM or a timer.
      const observer = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting === true));
      observer.observe(card);
      return () => observer.disconnect();
    }, [sessionId]);

    const fragmentRef = React.useRef(fragmentKey);
    React.useEffect(() => {
      if (fragmentRef.current === fragmentKey) return;
      fragmentRef.current = fragmentKey;
      // Drop the candidate the previous selection produced. Switching settings
      // must not cost a model call: the next turn end or a manual trigger rebuilds.
      assist.next.dismiss();
    }, [assist, fragmentKey]);
    React.useEffect(() => {
      assist.next.sync({ key, valid, visible: allowed && visible && !composing, ready: !!api && !fragmentInvalid,
        auto, request: { sessionId, endSeq: wireEndSeq(projection?.endSeq) } });
    }, [assist, key, valid, allowed, visible, composing, api, auto, fragmentInvalid,
      projection?.endSeq, sessionId]);
    React.useEffect(() => {
      // Clarification questions must survive IME composition while the human edits,
      // but not an empty draft, a running turn, or a closed composer.
      const keepQuestions = draftPreview.mode === 'questions' && draftPreview.phase === 'ready'
        && draft !== '' && !removed && phase === 'plain' && !running
        && projection?.openTurn === null && openState === 'open';
      assist.draft.sync({ valid: (draftValid && draft !== '') || keepQuestions, visible });
    }, [assist, draftValid, visible, draftPreview.mode, draftPreview.phase,
      draft, removed, phase, running, projection?.openTurn, openState]);
    // pause cancels all owned work; React owns the snapshot subscription cleanup.
    React.useEffect(() => () => assist.next.pause(), [assist]);
    const autoRef = React.useRef(auto);
    React.useEffect(() => {
      if (autoRef.current && !auto) assist.next.pause();
      autoRef.current = auto;
    }, [assist, auto]);

    React.useEffect(() => {
      const card = root.current?.closest('[data-composer-card]');
      if (!card) return;
      const editorOf = target => target instanceof Element
        ? target.closest('[data-composer-input]') : null;
      const ownEditor = target => {
        const editor = editorOf(target);
        return editor && card.contains(editor) && editor.closest('[data-composer-card]') === card
          && editor.isContentEditable && editor.getClientRects().length > 0 ? editor : null;
      };
      const dismiss = () => assist.next.dismiss();
      const onEdit = event => {
        if (!ownEditor(event.target)) return;
        browse.current = null;
        assist.notices.clear();
        assist.next.pause();
        // The clarification card stays readable while the human edits the draft.
        // A pending replacement/continuation is still invalidated by typing.
        const snapshot = assist.draft.getSnapshot();
        if (snapshot.mode === 'questions' && snapshot.phase === 'ready') return;
        assist.dismissDraft();
      };
      const startComposition = event => {
        if (!ownEditor(event.target)) return;
        setComposing(true);
        onEdit(event);
      };
      const endComposition = event => { if (ownEditor(event.target)) setComposing(false); };
      const onKeyDown = event => {
        const editor = ownEditor(event.target);
        const state = live.current;
        if (!editor || event.defaultPrevented || event.isComposing || event.keyCode === 229 || state.composing
          || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || state.phase !== 'plain'
          || !state.visible || card.closest('[inert], [aria-hidden="true"]')
          || card.querySelector('[role="listbox"], [role="dialog"]')) return;
        const nextState = assist.next.getSnapshot();
        const draftState = assist.draft.getSnapshot();
        const candidate = nextState?.key === state.key && (nextState.text || nextState.pending) ? nextState : null;
        if (event.key === 'Escape' && (candidate || draftState.phase !== 'idle')) {
          event.preventDefault(); event.stopPropagation();
          if (candidate) dismiss();
          assist.dismissDraft();
          return;
        }
        if (event.key === 'Tab') {
          // Manual continuation wins only when the draft is non-empty.
          if (draftState.kind === 'continuation' && draftState.phase === 'ready') {
            event.preventDefault(); event.stopPropagation();
            assist.applyContinuation();
            return;
          }
          if (state.allowed && candidate?.text) {
            // Selection + revision check prevents an asynchronous result overwriting typing.
            const span = state.inputActions.captureInsertion();
            if (state.inputActions.insertText(candidate.text, span)) {
              event.preventDefault(); event.stopPropagation(); dismiss();
            }
          }
          return;
        }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        // Chip coordinates and clipboard-text coordinates differ: preserve rich drafts.
        if (editor.querySelector('[contenteditable="false"]')) return;
        const active = browse.current?.last === state.draft ? browse.current : null;
        const span = state.inputActions.captureInsertion();
        if (span.start !== span.end) return;
        const direction = event.key === 'ArrowUp' ? 'up' : 'down';
        if (!active && (direction === 'up' ? state.draft.slice(0, span.start).includes('\n')
          : state.draft.slice(span.end).includes('\n'))) return;
        const next = browseHistory(active, state.draft, state.history ?? EMPTY, direction);
        if (!next) return;
        event.preventDefault(); event.stopPropagation();
        assist.next.pause();
        assist.dismissDraft();
        browse.current = next.index < 0 ? null : next;
        state.draft = next.last;
        state.inputActions.setDraft(next.last);
      };
      card.addEventListener('keydown', onKeyDown, true);
      card.addEventListener('beforeinput', onEdit, true);
      card.addEventListener('paste', onEdit, true);
      card.addEventListener('compositionstart', startComposition, true);
      card.addEventListener('compositionend', endComposition, true);
      return () => {
        card.removeEventListener('keydown', onKeyDown, true);
        card.removeEventListener('beforeinput', onEdit, true);
        card.removeEventListener('paste', onEdit, true);
        card.removeEventListener('compositionstart', startComposition, true);
        card.removeEventListener('compositionend', endComposition, true);
      };
    }, [assist, sessionId]);

    // state.key is written by the controller-sync path below; keep the historical
    // field available to the keyboard handler without re-subscribing.
    const shown = allowed && visible && !composing && preview?.key === key && !preview.pending
      ? preview : null;
    const draftActive = !shown?.text && (!!notice || draftPreview.phase !== 'idle');
    return h('div', { ref: root, 'data-prompt-assist-owner': sessionId,
      'data-prompt-assist-ready': shown?.text ? '' : undefined,
      'data-prompt-assist-draft': draftActive ? '' : undefined },
      shown?.text && h('div', { className: 'dsh-pa-preview', 'data-prompt-assist-preview': '',
        role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-text' }, shown.text),
        h('span', { className: 'dsh-pa-hint' }, t('preview.accept'))),
      draftActive && h(DraftPreview, { assist, t }));
  }

  function useAssist(sessionId) {
    useRegistryVersion();
    return registry.get(sessionId);
  }
  function useRegistryVersion() {
    return React.useSyncExternalStore(registrySource.subscribe, registrySource.getSnapshot);
  }
  function useConfig() {
    return React.useSyncExternalStore(
      configForm ? configForm.subscribe : noopSubscribe,
      configForm ? configForm.getSnapshot : () => EMPTY_CONFIG,
    );
  }

  function DraftPreview({ assist, t }) {
    const snapshot = React.useSyncExternalStore(assist.draft.subscribe, assist.draft.getSnapshot);
    const notice = React.useSyncExternalStore(assist.notices.subscribe, assist.notices.getSnapshot);
    const close = h('button', {
      type: 'button', className: 'dsh-pa-button',
      onPointerDown: event => event.preventDefault(),
      onClick: () => assist.dismissDraft(),
    }, t('dock.close'));
    if (notice) {
      return h('div', { className: 'dsh-pa-draft', 'data-prompt-assist-draft-panel': '',
        role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-draft-text' }, t(notice)));
    }
    if (snapshot.phase === 'idle') return null;
    if (snapshot.phase === 'pending') {
      return h('div', { className: 'dsh-pa-draft', 'data-prompt-assist-draft-panel': '',
        role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-draft-hint' }, t('dock.pending')));
    }
    if (snapshot.phase === 'error') {
      return h('div', { className: 'dsh-pa-draft', 'data-prompt-assist-draft-panel': '',
        role: 'alert', 'data-prompt-assist-optimize-mode': 'error' },
        h('span', { className: 'dsh-pa-draft-text dsh-pa-error' }, t(`error.${snapshot.reason}`)),
        h('span', { className: 'dsh-pa-draft-actions' }, close));
    }
    if (snapshot.kind === 'continuation') {
      return h('div', { className: 'dsh-pa-draft', 'data-prompt-assist-draft-panel': '',
        'data-prompt-assist-optimize-mode': 'continuation', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dsh-pa-draft-head' },
          h('span', { className: 'dsh-pa-draft-label' }, t('dock.continuation')),
          h('span', { className: 'dsh-pa-draft-hint' }, t('dock.hint'))),
        h('div', { className: 'dsh-pa-draft-text' }, snapshot.text));
    }
    if (snapshot.mode === 'questions') {
      return h('div', { className: 'dsh-pa-draft dsh-pa-questions',
        'data-prompt-assist-draft-panel': '', 'data-prompt-assist-optimize-mode': 'questions',
        role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'dsh-pa-draft-head' },
          h('span', { className: 'dsh-pa-draft-label' }, t('dock.questions')),
          h('span', { className: 'dsh-pa-draft-hint' }, t('dock.questionsHint'))),
        h('div', { className: 'dsh-pa-draft-text' }, snapshot.text),
        h('div', { className: 'dsh-pa-draft-actions' }, close));
    }
    return h('div', { className: 'dsh-pa-draft', 'data-prompt-assist-draft-panel': '',
      'data-prompt-assist-optimize-mode': 'replace', role: 'status', 'aria-live': 'polite' },
      h('div', { className: 'dsh-pa-draft-head' },
        h('span', { className: 'dsh-pa-draft-label' }, t('dock.optimize')),
        h('span', { className: 'dsh-pa-draft-hint' }, t('dock.applyHint'))),
      h('div', { className: 'dsh-pa-draft-text' }, snapshot.text),
      h('div', { className: 'dsh-pa-draft-actions' },
        h('button', { type: 'button', className: 'dsh-pa-button',
          onPointerDown: event => event.preventDefault(),
          onClick: () => assist.apply() }, t('dock.apply')),
        h('button', { type: 'button', className: 'dsh-pa-button',
          onPointerDown: event => event.preventDefault(),
          onClick: () => assist.dismissDraft() }, t('dock.cancel'))));
  }

  function OptimizeButton(props) {
    const { sessionId, useInput, useSession, inputActions, t } = props;
    const assist = useAssist(sessionId);
    const draft = useInput(s => s.draft);
    const phase = useInput(s => s.phase);
    const running = useSession(s => s.running);
    if (!assist) return null;
    const disabled = phase !== 'plain' || !draft || running;
    return h('button', {
      type: 'button', className: 'dsh-pa-button', disabled,
      title: t('button.optimizeTitle'), 'data-prompt-assist-optimize': '',
      onPointerDown: event => {
        event.preventDefault();
        if (disabled) return;
        assist.stageOptimize(inputActions.captureInsertion());
      },
      onClick: () => assist.optimize(),
    }, t('button.optimize'));
  }

  /**
   * Prompt-assist view: the per-session guidance/style pair plus the global
   * prompt settings that shape every suggestion. It lives in the conversation
   * view tab row (`conversation.view`) instead of the session header.
   */
  function PromptAssistView(props) {
    const translate = props.t ?? sessionT;
    const { sessionId } = props;
    const config = useConfig();
    const [failed, setFailed] = React.useState(false);
    const [saved, setSaved] = React.useState(false);
    const savedTimer = React.useRef(0);
    const mounted = React.useRef(true);
    React.useEffect(() => () => {
      mounted.current = false;
      clearTimeout(savedTimer.current);
    }, []);
    if (!configForm || !config || config.status === 'loading' || config.value === undefined) {
      return h('div', { className: 'dsh-pa-view' },
        h('div', { className: 'dsh-pa-settings' },
          h('span', { className: 'dsh-pa-desc' }, translate('view.loading'))));
    }
    if (config.status === 'unavailable') {
      return h('div', { className: 'dsh-pa-view' },
        h('div', { className: 'dsh-pa-settings' },
          h('span', { className: 'dsh-pa-desc' }, translate('view.unavailable'))));
    }
    const value = config.value;
    const auto = value.autoPredict !== false;
    const strategy = value.optimizeStrategy === 'clarify' ? 'clarify' : 'expand';
    const resolved = sessionId ? resolveSelection(value, sessionId) : { error: 'session-missing' };
    const own = sessionId ? sessionOverride(value, sessionId) : undefined;
    const fallback = resolved.sessionFallback ?? {};
    const globalDirection = typeof value.directionId === 'string' && value.directionId
      ? value.directionId : DEFAULT_DIRECTION_ID;
    const globalStyle = typeof value.styleId === 'string' && value.styleId
      ? value.styleId : DEFAULT_STYLE_ID;
    const markSaved = () => {
      if (!mounted.current) return;
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => { if (mounted.current) setSaved(false); }, 2600);
    };
    const finish = ok => { if (mounted.current) setFailed(!ok); };
    // Serialise session writes: two quick selections must merge against the
    // value the previous write committed, not against this render's snapshot.
    const writeSession = change => {
      sessionWriteQueue = sessionWriteQueue.then(async () => {
        let ok = false;
        try {
          const snapshot = configForm.getSnapshot();
          const current = (snapshot?.value ?? {}).sessionOverrides;
          const next = withSessionOverride(current, sessionId, change);
          ok = await configForm.set('sessionOverrides', next);
        } catch { ok = false; }
        finish(ok);
        if (ok) markSaved();
      }, () => finish(false));
    };
    const setGlobal = (field, next) => {
      void Promise.resolve(configForm.set(field, next)).then(ok => {
        finish(ok);
        if (ok) markSaved();
      }, () => finish(false));
    };
    const select = (kind, storedId, globalId, label) => {
      const rows = optionRowsFor(value, kind, translate);
      // A stored id that no longer resolves stays visible as a disabled option,
      // so the control matches what is persisted and "Global" can clear it.
      const stale = storedId !== '' && !rows.some(row => row.id === storedId);
      return h('span', { className: 'dsh-pa-select-wrap' },
        h('select', {
          className: 'dsh-pa-select',
          value: storedId,
          'aria-label': label,
          onChange: event => writeSession(kind === 'style'
            ? { styleId: event.target.value } : { directionId: event.target.value }),
        },
          h('option', { value: '' },
            `${translate('sessionStrategy.inheritShort')} · ${fragmentLabel(value, kind, globalId, translate)}`),
          stale && h('option', { value: storedId, disabled: true }, translate('sessionStrategy.stale')),
          rows.map(row => h('option', { key: row.id, value: row.id }, row.label))));
    };
    const sessionCard = resolved.error
      ? h('div', { className: 'dsh-pa-card' },
        h('span', { className: 'dsh-pa-desc dsh-pa-inline-error', role: 'alert' },
          translate('settings.fragmentInvalid')))
      : h('div', { className: 'dsh-pa-card' },
        h('div', { className: 'dsh-pa-field' },
          h('span', { className: 'dsh-pa-field-label' }, translate('sessionStrategy.direction')),
          select('direction', own?.directionId ?? '', globalDirection, translate('sessionStrategy.direction'))),
        h('div', { className: 'dsh-pa-field' },
          h('span', { className: 'dsh-pa-field-label' }, translate('sessionStrategy.style')),
          select('style', own?.styleId ?? '', globalStyle, translate('sessionStrategy.style'))),
        (fallback.direction || fallback.style) && h('span', {
          className: 'dsh-pa-desc dsh-pa-inline-error', role: 'status',
        }, translate('sessionStrategy.fallback')),
        saved && h('span', { className: 'dsh-pa-desc', role: 'status', 'aria-live': 'polite' },
          translate('sessionStrategy.saved')));
    return h('div', { className: 'dsh-pa-view' },
      h('div', { className: 'dsh-pa-settings' },
        h('section', { className: 'dsh-pa-group' },
          h('h3', { className: 'dsh-pa-group-title' }, translate('view.sessionGroup')),
          h('span', { className: 'dsh-pa-desc' }, translate('sessionStrategy.viewHint')),
          sessionCard),
        h('section', { className: 'dsh-pa-group' },
          h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.automation')),
          h('div', { className: 'dsh-pa-row' },
            h('div', { className: 'dsh-pa-row-text' },
              h('span', { className: 'dsh-pa-title' }, translate('settings.auto')),
              h('span', { className: 'dsh-pa-desc' }, translate('settings.autoHint'))),
            h('button', { type: 'button', role: 'switch', className: 'dsh-pa-switch',
              'aria-checked': auto ? 'true' : 'false', 'aria-label': translate('settings.auto'),
              onClick: () => setGlobal('autoPredict', !auto) }))),
        h('section', { className: 'dsh-pa-group' },
          h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.optimize')),
          h('div', { className: 'dsh-pa-card' },
            h('div', { className: 'dsh-pa-field' },
              h('span', { className: 'dsh-pa-field-label' }, translate('settings.optimizeStrategy')),
              h('span', { className: 'dsh-pa-select-wrap' },
                h('select', { className: 'dsh-pa-select', value: strategy,
                  'aria-label': translate('settings.optimizeStrategy'),
                  onChange: event => setGlobal('optimizeStrategy', event.target.value) },
                  h('option', { value: 'clarify' }, translate('settings.optimizeClarify')),
                  h('option', { value: 'expand' }, translate('settings.optimizeExpand'))))),
            h('span', { className: 'dsh-pa-desc' }, translate('settings.optimizeHint')))),
        h('section', { className: 'dsh-pa-group' },
          h('h3', { className: 'dsh-pa-group-title' }, translate('view.moreGroup')),
          h('span', { className: 'dsh-pa-desc' }, translate('view.moreHint'))),
        failed && h('span', { className: 'dsh-pa-desc dsh-pa-inline-error', role: 'alert' },
          translate('sessionStrategy.saveFailed'))));
  }

  function SettingsPage() {
    const translate = settingsT;
    const config = useConfig();
    const api = React.useSyncExternalStore(bridgeSource.subscribe, bridgeSource.getSnapshot);
    const catalog = React.useSyncExternalStore(
      shortcuts ? shortcuts.catalog.subscribe : noopSubscribe,
      shortcuts ? shortcuts.catalog.getSnapshot : () => EMPTY_CATALOG,
    );
    const [models, setModels] = React.useState(EMPTY_MODELS);
    const [saveError, setSaveError] = React.useState(false);
    const [savedSelection, setSavedSelection] = React.useState('');
    React.useEffect(() => {
      if (!savedSelection) return undefined;
      const timer = setTimeout(() => setSavedSelection(''), 2600);
      return () => clearTimeout(timer);
    }, [savedSelection]);
    const [draft, setDraft] = React.useState(null);
    const [touched, setTouched] = React.useState(false);
    const [discard, setDiscard] = React.useState(false);
    const [editorError, setEditorError] = React.useState('');
    const instructionRef = React.useRef(null);
    React.useEffect(() => {
      if (!api) { setModels({ status: 'loading', providers: [] }); return () => {}; }
      const controller = new AbortController();
      let live = true;
      api.listModels({}, controller.signal).then(result => {
        if (!live) return;
        const value = result?.ok ? result.value : undefined;
        if (value?.status === 'ready') setModels({ status: 'ready', providers: value.providers });
        else setModels({ status: 'error', providers: [] });
      }, () => { if (live) setModels({ status: 'error', providers: [] }); });
      return () => { live = false; controller.abort(); };
    }, [api]);
    if (!configForm || config?.status === 'unavailable') {
      return h('div', { className: 'dsh-pa-settings' }, h('div', { className: 'dsh-pa-setting-hint' },
        translate('settings.unavailable')));
    }
    const value = config?.value ?? {};
    const provider = typeof value.provider === 'string' ? value.provider : '';
    const model = typeof value.model === 'string' ? value.model : '';
    const auto = value.autoPredict !== false;
    const optimizeStrategyValue = value.optimizeStrategy === 'clarify' ? 'clarify' : 'expand';
    const providerEntry = models.providers?.find(item => item.id === provider);
    const providers = models.providers ?? [];
    const shortcutRows = (catalog ?? [])
      .filter(row => row.id === 'dsh-prompt-assist.predict' || row.id === 'dsh-prompt-assist.toggle-auto');
    const setField = (field, next) => {
      void Promise.resolve(configForm.set(field, next)).then(ok => setSaveError(!ok), () => setSaveError(true));
    };
    const setSelection = (field, next) => {
      void Promise.resolve(configForm.set(field, next)).then(ok => {
        if (ok) setSavedSelection(field); else setSaveError(true);
      }, () => setSaveError(true));
    };
    const fragment = resolveSelection(value);
    const directionId = typeof value.directionId === 'string' && value.directionId
      ? value.directionId : DEFAULT_DIRECTION_ID;
    const styleId = typeof value.styleId === 'string' && value.styleId ? value.styleId : DEFAULT_STYLE_ID;
    const optionsFor = kind => optionRowsFor(value, kind, translate);
    const optionRows = (rows, selected) => {
      const list = rows.some(row => row.id === selected)
        ? rows : [{ id: selected, label: translate('settings.fragmentInvalidOption') }, ...rows];
      return list.map(row => h('option', { key: row.id, value: row.id }, row.label));
    };
    const fragments = (Array.isArray(value.fragments) ? value.fragments : [])
      .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id !== '');
    const selectedId = kind => (kind === 'style' ? styleId : directionId);
    const editorMessage = code => translate(PROBLEM_KEYS[code] ?? 'fragment.error.save');
    const openNew = kind => {
      setEditorError(''); setDiscard(false); setTouched(false);
      setDraft({ mode: 'new', kind, id: '', name: '', description: '', instruction: '' });
    };
    const openEdit = item => {
      setEditorError(''); setDiscard(false); setTouched(false);
      setDraft({ mode: 'edit', kind: item.kind, id: item.id, name: item.name ?? '',
        description: item.description ?? '', instruction: item.instruction ?? '',
        revision: item.revision ?? 1 });
    };
    const openCopy = item => {
      const base = item.seed === true ? translate(`seed.${item.id}`) : (item.name ?? item.id);
      setEditorError(''); setDiscard(false); setTouched(false);
      setDraft({ mode: 'new', kind: item.kind,
        id: `custom-${Math.random().toString(36).slice(2, 8)}`,
        name: `${base} ${translate('settings.copySuffix')}`,
        description: item.description ?? '', instruction: item.instruction ?? '' });
    };
    const closeEditor = () => {
      if (draft && touched) { setDiscard(true); return; }
      setDraft(null); setEditorError(''); setDiscard(false); setTouched(false);
    };
    const saveDraft = () => {
      if (!draft) return;
      const candidate = {
        id: draft.id || `custom-${Math.random().toString(36).slice(2, 8)}`,
        kind: draft.kind,
        name: (draft.name ?? '').trim(),
        description: (draft.description ?? '').trim(),
        instruction: draft.instruction ?? '',
        enabled: true,
        revision: draft.mode === 'edit' ? Number(draft.revision ?? 1) + 1 : 1,
      };
      const problem = fragmentProblem(candidate);
      if (problem) { setEditorError(problem); return; }
      const next = [...fragments];
      const index = next.findIndex(item => item.id === candidate.id && item.kind === candidate.kind);
      if (index === -1) next.push(candidate); else next[index] = candidate;
      if (next.length > LIMITS.fragments) { setEditorError('fragments-limit'); return; }
      void Promise.resolve(configForm.set('fragments', next)).then(ok => {
        if (!ok) { setSaveError(true); return; }
        setDraft(null); setEditorError(''); setDiscard(false); setTouched(false);
        setSavedSelection('fragments');
      }, () => setSaveError(true));
    };
    const toggleFragment = item => {
      const next = fragments.map(entry => (entry.id === item.id && entry.kind === item.kind)
        ? { ...entry, enabled: item.enabled === false } : entry);
      void Promise.resolve(configForm.set('fragments', next)).then(ok => {
        if (!ok) setSaveError(true); else setEditorError('');
      }, () => setSaveError(true));
    };
    const removeFragment = item => {
      if (item.id === selectedId(item.kind)) { setEditorError('fragment-in-use'); return; }
      const next = fragments.filter(entry => !(entry.id === item.id && entry.kind === item.kind));
      void Promise.resolve(configForm.set('fragments', next)).then(ok => {
        if (!ok) setSaveError(true); else { setEditorError(''); setSavedSelection('fragments'); }
      }, () => setSaveError(true));
    };
    const insertVariable = token => {
      if (!draft) return;
      const element = instructionRef.current;
      const text = draft.instruction ?? '';
      const start = typeof element?.selectionStart === 'number' ? element.selectionStart : text.length;
      const end = typeof element?.selectionEnd === 'number' ? element.selectionEnd : text.length;
      setDraft({ ...draft, instruction: `${text.slice(0, start)}${token}${text.slice(end)}` });
      setTouched(true);
      setEditorError('');
      globalThis.requestAnimationFrame?.(() => {
        element?.focus();
        element?.setSelectionRange(start + token.length, start + token.length);
      });
    };
    const fragmentCard = h('div', { className: 'dsh-pa-card' },
      h('div', { className: 'dsh-pa-card-head' },
        h('span', { className: 'dsh-pa-card-title' }, translate('settings.fragments')),
        h('span', { className: 'dsh-pa-desc' }, translate('settings.fragmentsHint'))),
      h('div', { className: 'dsh-pa-row-actions' },
        h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => openNew('direction') },
          translate('settings.newDirection')),
        h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => openNew('style') },
          translate('settings.newStyle'))),
      editorError && draft === null && h('span', { className: 'dsh-pa-desc dsh-pa-inline-error', role: 'alert' },
        editorMessage(editorError)),
      [...DIRECTIONS.map(item => ({ ...item, kind: 'direction', seed: true })),
        ...STYLES.map(item => ({ ...item, kind: 'style', seed: true }))].map(item =>
        h('div', { key: `seed:${item.kind}:${item.id}`, className: 'dsh-pa-entry' },
          h('div', { className: 'dsh-pa-entry-text' },
            h('span', { className: 'dsh-pa-entry-name' }, translate(`seed.${item.id}`)),
            h('span', { className: 'dsh-pa-entry-meta' },
              translate(item.kind === 'style' ? 'settings.kindStyle' : 'settings.kindDirection'),
              ` · ${translate('settings.builtin')}`)),
          h('div', { className: 'dsh-pa-entry-actions' },
            h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => openCopy(item) },
              translate('settings.copy'))))),
      fragments.length === 0 && draft === null && h('span', { className: 'dsh-pa-desc' },
        translate('settings.noFragments')),
      fragments.map(item => h('div', { key: `${item.kind}:${item.id}`, className: 'dsh-pa-entry' },
        h('div', { className: 'dsh-pa-entry-text' },
          h('span', { className: 'dsh-pa-entry-name' }, item.name ?? item.id),
          h('span', { className: 'dsh-pa-entry-meta' },
            translate(item.kind === 'style' ? 'settings.kindStyle' : 'settings.kindDirection'),
            item.enabled === false ? ` · ${translate('settings.fragmentOff')}` : '',
            item.id === selectedId(item.kind) ? ` · ${translate('settings.fragmentUsed')}` : '')),
        h('div', { className: 'dsh-pa-entry-actions' },
          h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => openEdit(item) },
            translate('settings.edit')),
          h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => openCopy(item) },
            translate('settings.copy')),
          h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => toggleFragment(item) },
            translate(item.enabled === false ? 'settings.enable' : 'settings.disable')),
          h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => removeFragment(item) },
            translate('settings.delete'))))),
      draft !== null && h('div', { className: 'dsh-pa-editor' },
        h('label', { className: 'dsh-pa-field' },
          h('span', { className: 'dsh-pa-field-label' }, translate('settings.fragmentName')),
          h('input', { className: 'dsh-pa-input', type: 'text', value: draft.name, maxLength: LIMITS.name,
            'aria-label': translate('settings.fragmentName'),
            onChange: event => {
              setDraft({ ...draft, name: event.target.value }); setTouched(true); setEditorError('');
            } })),
        h('label', { className: 'dsh-pa-field' },
          h('span', { className: 'dsh-pa-field-label' }, translate('settings.fragmentDescription')),
          h('input', { className: 'dsh-pa-input', type: 'text', value: draft.description, maxLength: LIMITS.description,
            'aria-label': translate('settings.fragmentDescription'),
            onChange: event => {
              setDraft({ ...draft, description: event.target.value }); setTouched(true); setEditorError('');
            } })),
        h('div', { className: 'dsh-pa-editor-instruction' },
          h('span', { className: 'dsh-pa-field-label' }, translate('settings.fragmentInstruction')),
          h('textarea', { className: 'dsh-pa-textarea', ref: instructionRef, rows: 6, value: draft.instruction,
            'aria-label': translate('settings.fragmentInstruction'),
            onChange: event => {
              setDraft({ ...draft, instruction: event.target.value }); setTouched(true); setEditorError('');
            } }),
          h('span', { className: 'dsh-pa-desc' }, `${draft.instruction.length} / ${LIMITS.instruction}`),
          h('div', { className: 'dsh-pa-vars' }, VARIABLES.map(name => h('button', {
            key: name, type: 'button', className: 'dsh-pa-var',
            onClick: () => insertVariable(`{{${name}}}`),
          }, `{{${name}}}`)))),
        editorError && draft !== null && h('span', { className: 'dsh-pa-desc dsh-pa-inline-error', role: 'alert' },
          editorMessage(editorError)),
        discard && h('div', { className: 'dsh-pa-discard' },
          h('span', { className: 'dsh-pa-desc' }, translate('settings.unsaved')),
          h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => {
            setDraft(null); setDiscard(false); setTouched(false); setEditorError('');
          } }, translate('settings.discard')),
          h('button', { type: 'button', className: 'dsh-pa-button', onClick: () => setDiscard(false) },
            translate('settings.keepEditing'))),
        h('div', { className: 'dsh-pa-row-actions' },
          h('button', { type: 'button', className: 'dsh-pa-button dsh-pa-button-primary', onClick: saveDraft },
            translate('settings.save')),
          h('button', { type: 'button', className: 'dsh-pa-reset', onClick: closeEditor },
            translate('settings.cancel')))));

    const clearRoute = () => {
      void Promise.all([configForm.unset('provider'), configForm.unset('model')])
        .then(results => setSaveError(results.some(ok => !ok)), () => setSaveError(true));
    };
    return h('div', { className: 'dsh-pa-settings' },
      h('section', { className: 'dsh-pa-group' },
        h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.automation')),
        h('div', { className: 'dsh-pa-row' },
          h('div', { className: 'dsh-pa-row-text' },
            h('span', { className: 'dsh-pa-title' }, translate('settings.auto')),
            h('span', { className: 'dsh-pa-desc' }, translate('settings.autoHint'))),
          h('button', { type: 'button', role: 'switch', className: 'dsh-pa-switch',
            'aria-checked': auto ? 'true' : 'false', 'aria-label': translate('settings.auto'),
            onClick: () => { setField('autoPredict', !auto); } }))),
      h('section', { className: 'dsh-pa-group' },
        h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.model')),
        h('div', { className: 'dsh-pa-card' },
          h('div', { className: 'dsh-pa-card-head' },
            h('span', { className: 'dsh-pa-desc' }, translate('settings.modelHint'))),
          h('div', { className: 'dsh-pa-field' },
            h('span', { className: 'dsh-pa-field-label' }, translate('settings.provider')),
            h('span', { className: 'dsh-pa-select-wrap' },
              h('select', { className: 'dsh-pa-select', value: provider, 'aria-label': translate('settings.provider'),
                onChange: event => {
                  const next = event.target.value;
                  if (!next) clearRoute();
                  else { setField('provider', next); void configForm.unset('model'); }
                } },
                h('option', { value: '' }, translate('settings.follow')),
                providers.map(item => h('option', { key: item.id, value: item.id }, item.name))))),
          provider !== '' && h('div', { className: 'dsh-pa-field' },
            h('span', { className: 'dsh-pa-field-label' }, translate('settings.modelRow')),
            h('span', { className: 'dsh-pa-select-wrap' },
              h('select', { className: 'dsh-pa-select', value: model, disabled: !providerEntry,
                'aria-label': translate('settings.modelRow'),
                onChange: event => { setField('model', event.target.value); } },
                h('option', { value: '' }, translate('settings.modelDefault')),
                (providerEntry?.models ?? []).map(item => h('option', { key: item.id, value: item.id }, item.name))))),
          provider !== '' && h('button', { type: 'button', className: 'dsh-pa-reset',
            onClick: clearRoute }, translate('settings.followSession')),
          models.status === 'loading' && h('span', { className: 'dsh-pa-desc' }, translate('settings.loading')),
          models.status === 'error' && h('span', { className: 'dsh-pa-desc dsh-pa-inline-error' }, translate('settings.modelsError')),
          models.status === 'ready' && providers.length === 0
            && h('span', { className: 'dsh-pa-desc' }, translate('settings.modelsEmpty')))),
      h('section', { className: 'dsh-pa-group' },
        h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.optimize')),
        h('div', { className: 'dsh-pa-card' },
          h('div', { className: 'dsh-pa-field' },
            h('span', { className: 'dsh-pa-field-label' }, translate('settings.optimizeStrategy')),
            h('span', { className: 'dsh-pa-select-wrap' },
              h('select', { className: 'dsh-pa-select', value: optimizeStrategyValue,
                'aria-label': translate('settings.optimizeStrategy'),
                onChange: event => { setField('optimizeStrategy', event.target.value); } },
                h('option', { value: 'clarify' }, translate('settings.optimizeClarify')),
                h('option', { value: 'expand' }, translate('settings.optimizeExpand'))))),
          h('span', { className: 'dsh-pa-desc' }, translate('settings.optimizeHint')))),
      h('section', { className: 'dsh-pa-group' },
        h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.next')),
        h('div', { className: 'dsh-pa-card' },
          fragment.error && h('span', { className: 'dsh-pa-desc dsh-pa-inline-error', role: 'alert' },
            translate('settings.fragmentInvalid')),
          h('div', { className: 'dsh-pa-field' },
            h('span', { className: 'dsh-pa-field-label' }, translate('settings.direction')),
            h('span', { className: 'dsh-pa-select-wrap' },
              h('select', { className: 'dsh-pa-select', value: directionId,
                'aria-label': translate('settings.direction'),
                onChange: event => setSelection('directionId', event.target.value) },
                optionRows(optionsFor('direction'), directionId)))),
          h('span', { className: 'dsh-pa-desc' }, translate('settings.directionHint')),
          h('div', { className: 'dsh-pa-field' },
            h('span', { className: 'dsh-pa-field-label' }, translate('settings.style')),
            h('span', { className: 'dsh-pa-select-wrap' },
              h('select', { className: 'dsh-pa-select', value: styleId,
                'aria-label': translate('settings.style'),
                onChange: event => setSelection('styleId', event.target.value) },
                optionRows(optionsFor('style'), styleId)))),
          h('span', { className: 'dsh-pa-desc' }, translate('settings.styleHint')),
          savedSelection && h('span', { className: 'dsh-pa-desc' }, translate('settings.nextSaved'))),
        fragmentCard),
      h('section', { className: 'dsh-pa-group' },
        h('h3', { className: 'dsh-pa-group-title' }, translate('settings.group.shortcuts')),
        shortcutRows.map(row => h('div', { key: row.id, className: 'dsh-pa-row' },
          h('span', { className: 'dsh-pa-title' }, row.label),
          row.keys.length
            ? h('span', { className: 'dsh-pa-keys' },
              row.keys.map(label => h('kbd', { key: label, className: 'dsh-pa-kbd' }, label)))
            : h('span', { className: 'dsh-pa-kbd-unbound' }, translate('settings.unbound')))),
        h('span', { className: 'dsh-pa-desc' }, translate('settings.shortcutsHint')),
        shortcutDegraded && h('span', { className: 'dsh-pa-desc' }, translate('settings.shortcutsDegraded'))),
      saveError && h('div', { className: 'dsh-pa-desc dsh-pa-inline-error', role: 'alert' }, translate('settings.saveFailed')),
    );
  }

  let settingsT = key => key;
  let sessionT = key => key;
  // Session writes are serialised for the whole module: switching tabs unmounts
  // the view, and a per-mount queue would merge against a stale snapshot.
  let sessionWriteQueue = Promise.resolve();

  function registerCommand(ctx, definition, logger) {
    try {
      return ctx.shortcuts.register(definition);
    } catch (error) {
      shortcutDegraded = true;
      logger.warn?.('prompt-assist: shortcut defaults unavailable for %s: %s', definition.id, error?.message ?? error);
      try { return ctx.shortcuts.register({ ...definition, defaults: {} }); }
      catch { return () => {}; }
    }
  }

  return {
    inject: ['slots', 'locale', 'remote', 'shortcuts', 'configForms'],
    async apply(ctx) {
      const t = ctx.locale.bind(NS);
      const logger = ctx.logger ?? console;
      settingsT = key => t(key);
      sessionT = key => t(key);
      const form = ctx.configForms.get(SETTINGS_NS);
      configForm = {
        getSnapshot: () => form.getSnapshot(),
        subscribe: listener => form.subscribe(listener),
        set: (field, value) => form.set(field, value),
        unset: field => form.unset(field),
      };
      shortcuts = ctx.shortcuts;
      ctx.locale.register(NS, 'zh', {
        'preview.label': '下一句建议', 'preview.accept': 'Tab 采纳 · Esc 忽略', 'preview.pending': '正在用当前会话模型生成建议…',
        'command.predict': '触发提示词预测', 'command.toggle': '切换自动提示词预测',
        'dock.continuation': '续写', 'dock.hint': 'Tab 插入 · Esc 忽略', 'dock.pending': '正在生成…',
        'dock.apply': '应用', 'dock.cancel': '取消', 'dock.close': '关闭', 'dock.questions': '需要先补充信息',
        'dock.optimize': '优化预览', 'dock.applyHint': '确认后写回草稿', 'dock.questionsHint': '草稿未修改；补充后重新点击优化',
        'button.optimize': '优化', 'button.optimizeTitle': '把选中文本（无选区时整段草稿）改写成更清晰的指令',
        'settings.title': '提示词助手', 'settings.auto': '自动提示词预测',
        'settings.autoHint': '整轮回答完成后自动生成下一句建议。',
        'settings.model': '辅助模型', 'settings.follow': '跟随会话模型',
        'settings.provider': '提供商', 'settings.modelId': '选择模型',
        'settings.shortcuts': '快捷键', 'settings.shortcutsHint': '在 设置 → 通用 → 快捷键 中修改。',
        'settings.shortcutsDegraded': '默认快捷键不可用，请在快捷键设置中手动指定。',
        'settings.unavailable': '未找到插件配置，请确认插件以标准 bundle 方式安装。',
        'settings.group.automation': '自动预测', 'settings.group.model': '辅助模型', 'settings.group.shortcuts': '快捷键',
        'settings.modelRow': '模型', 'settings.modelDefault': '使用提供商默认模型',
        'settings.modelHint': '默认跟随会话模型；选择其他模型后，下一句、续写与优化都用它生成。',
        'sessionStrategy.direction': '方向', 'sessionStrategy.style': '风格',
        'sessionStrategy.inheritShort': '跟随全局', 'sessionStrategy.stale': '（已失效）',
        'sessionStrategy.fallback': '本会话原来的选择已失效，正在使用全局默认。',
        'sessionStrategy.saveFailed': '保存失败，请重试。',
        'sessionStrategy.viewHint': '只影响当前会话的下一句预测；选择「跟随全局」时使用全局默认。',
        'sessionStrategy.saved': '已保存，将用于下一次建议。',
        'view.promptAssist': '提示助手', 'view.sessionGroup': '本会话', 'view.moreGroup': '更多配置',
        'view.moreHint': '辅助模型、自定义方向/风格条目与快捷键在「设置 → 提示词助手」中管理。',
        'view.unavailable': '提示词助手配置暂不可用，请稍后刷新页面。',
        'view.loading': '正在加载提示词助手配置…',
        'settings.group.next': '下一句预测',
        'settings.direction': '引导方向', 'settings.style': '表达风格',
        'settings.directionHint': '决定建议问什么；切换后对下一次建议生效。',
        'settings.styleHint': '决定建议怎么问，不改变追问对象。',
        'settings.nextSaved': '已保存，将用于下一次建议。',
        'settings.fragmentInvalid': '当前选择的方向或风格已失效，请重新选择。',
        'settings.fragmentInvalidOption': '（已失效）',
        'settings.fragments': '自定义条目', 'settings.fragmentsHint': '内置条目只是起点；复制或新建后按自己的方法改写生成指令。',
        'settings.newDirection': '新建方向', 'settings.newStyle': '新建风格', 'settings.noFragments': '还没有自定义条目。',
        'settings.edit': '编辑', 'settings.copy': '复制', 'settings.enable': '启用', 'settings.disable': '停用',
        'settings.delete': '删除', 'settings.save': '保存', 'settings.cancel': '取消',
        'settings.discard': '放弃修改', 'settings.keepEditing': '继续编辑', 'settings.unsaved': '有未保存的修改。',
        'settings.fragmentName': '名称', 'settings.fragmentDescription': '说明', 'settings.fragmentInstruction': '生成指令',
        'settings.kindDirection': '方向', 'settings.kindStyle': '风格', 'settings.builtin': '内置',
        'settings.fragmentOff': '已停用', 'settings.fragmentUsed': '使用中', 'settings.copySuffix': '（副本）',
        'fragment.error.emptyName': '请填写名称。', 'fragment.error.nameLimit': '名称超出长度上限。',
        'fragment.error.descriptionLimit': '说明超出长度上限。',
        'fragment.error.emptyInstruction': '请填写生成指令。', 'fragment.error.instructionLimit': '指令超出长度上限。',
        'fragment.error.unknownVariable': '包含未知变量，只支持下方列出的变量。',
        'fragment.error.duplicate': '同一类型下已有相同 ID 的条目。', 'fragment.error.fragmentsLimit': '自定义条目数量已达上限。',
        'fragment.error.invalid': '条目结构不完整。', 'fragment.error.inUse': '这个条目正在使用中，请先在下方选择器换一个再删除。',
        'fragment.error.save': '保存失败，请重试。',
        'seed.natural-followup': '自然延续', 'seed.challenge': '质疑',
        'seed.alternative': '替代路径', 'seed.action': '行动推进',
        'seed.concise': '简洁直接', 'seed.precise': '严谨工程化',
        'settings.group.optimize': '优化策略', 'settings.optimizeStrategy': '优化方向',
        'settings.optimizeClarify': '澄清优化', 'settings.optimizeExpand': '忠实扩写',
        'settings.optimizeHint': '澄清优化只消除歧义，几乎不改写；忠实扩写会调整用词、补出草稿已经蕴含的细节，但不会新增目标或验收标准。',
        'settings.followSession': '恢复跟随会话模型',
        'settings.loading': '正在读取模型列表…', 'settings.modelsError': '模型列表读取失败。',
        'settings.modelsEmpty': '没有可用的模型。', 'settings.unbound': '未绑定',
        'settings.saveFailed': '设置保存失败，请重试。',
        'error.no-model': '会话还没有选择模型，先在输入栏选一个模型。',
        'error.model-unavailable': '模型不可用，请检查 DSH 的模型设置或“提示词助手”中配置的辅助模型。',
        'error.invalid-output': '模型输出格式不符合要求，请重试。',
        'error.limit': '输出超出长度限制，请缩短文本后重试。',
        'error.timeout': '请求超时，请重试。', 'error.provider-error': '模型请求失败，请重试。',
        'error.request-rejected': '插件与 DSH 的请求未通过校验，未发出模型调用；请更新插件或反馈此问题。',
        'error.empty': '没有可用的结果。', 'error.stale': '内容已变化，请重试。',
        'error.unavailable': '当前不能执行该操作。', 'error.attachments': '带附件的草稿暂不支持续写。',
        'error.selection': '请先取消选区再续写。', 'error.chips': '草稿含引用，暂不支持整段优化；可选中不含引用的文字后再优化。',
        'error.empty-draft': '请先输入内容。', 'error.caret-moved': '光标已移动，请重新触发。',
        'error.no-prefix': '把光标放到草稿文字后面再触发续写。',
        'error.save-failed': '设置保存失败，请重试。',
        'notice.auto-on': '自动提示词预测已开启。', 'notice.auto-off': '自动提示词预测已关闭。',
        'error.predict-failed': '提示词预测失败，请重试或检查设置。',
        'error.fragment-invalid': '当前方向或风格已失效，请到设置页重新选择。',
      });
      ctx.locale.register(NS, 'en', {
        'preview.label': 'Suggested next prompt', 'preview.accept': 'Tab to accept · Esc to dismiss',
        'preview.pending': 'Generating with the session’s model…',
        'command.predict': 'Trigger prompt prediction', 'command.toggle': 'Toggle automatic prompt prediction',
        'dock.continuation': 'Continuation', 'dock.hint': 'Tab to insert · Esc to dismiss',
        'dock.pending': 'Generating…', 'dock.apply': 'Apply', 'dock.cancel': 'Cancel',
        'dock.close': 'Close', 'dock.questions': 'More information needed',
        'dock.optimize': 'Optimization preview', 'dock.applyHint': 'Writes to the draft only after Apply', 'dock.questionsHint': 'Draft unchanged; edit it and run Optimize again',
        'button.optimize': 'Optimize', 'button.optimizeTitle': 'Rewrite the selected prompt (or the whole draft) into a clearer instruction',
        'settings.title': 'Prompt assist', 'settings.auto': 'Automatic prompt prediction',
        'settings.autoHint': 'Generate a next-prompt suggestion after each completed answer.',
        'settings.model': 'Auxiliary model', 'settings.follow': 'Follow the session model',
        'settings.provider': 'Provider', 'settings.modelId': 'Select a model',
        'settings.shortcuts': 'Shortcuts', 'settings.shortcutsHint': 'Change them in Settings → General → Shortcuts.',
        'settings.shortcutsDegraded': 'The default shortcuts are unavailable; assign them in Shortcuts settings.',
        'settings.unavailable': 'Plugin configuration was not found. Check that the plugin was installed as a standard bundle.',
        'settings.group.automation': 'Automation', 'settings.group.model': 'Auxiliary model', 'settings.group.shortcuts': 'Shortcuts',
        'settings.modelRow': 'Model', 'settings.modelDefault': 'Use the provider default',
        'settings.modelHint': 'Follows the session model by default; when another model is selected it also generates previews, continuations and optimizations.',
        'sessionStrategy.direction': 'Guidance', 'sessionStrategy.style': 'Style',
        'sessionStrategy.inheritShort': 'Global', 'sessionStrategy.stale': '(unavailable)',
        'sessionStrategy.fallback': 'The previous choice for this session is unavailable; the global default is in effect.',
        'sessionStrategy.saveFailed': 'Saving failed. Try again.',
        'sessionStrategy.viewHint': 'Applies to this session’s next-prompt suggestion only; "Global" uses the global default.',
        'sessionStrategy.saved': 'Saved. Applies to the next suggestion.',
        'view.promptAssist': 'Prompt assist', 'view.sessionGroup': 'This session', 'view.moreGroup': 'More settings',
        'view.moreHint': 'The auxiliary model, custom guidance/style entries and shortcuts live under Settings → Prompt assist.',
        'view.unavailable': 'Prompt-assist settings are unavailable right now; refresh the page and try again.',
        'view.loading': 'Loading prompt-assist settings…',
        'settings.group.next': 'Next prompt',
        'settings.direction': 'Guidance', 'settings.style': 'Expression style',
        'settings.directionHint': 'What the suggestion asks about; applies to the next suggestion.',
        'settings.styleHint': 'How the suggestion is worded; the target does not change.',
        'settings.nextSaved': 'Saved. Applies to the next suggestion.',
        'settings.fragmentInvalid': 'The selected guidance or style is unavailable. Pick another one.',
        'settings.fragmentInvalidOption': '(unavailable)',
        'settings.fragments': 'Custom entries',
        'settings.fragmentsHint': 'The built-in entries are a starting point; copy or create one and rewrite its generation instruction.',
        'settings.newDirection': 'New guidance', 'settings.newStyle': 'New style', 'settings.noFragments': 'No custom entries yet.',
        'settings.edit': 'Edit', 'settings.copy': 'Duplicate', 'settings.enable': 'Enable', 'settings.disable': 'Disable',
        'settings.delete': 'Delete', 'settings.save': 'Save', 'settings.cancel': 'Cancel',
        'settings.discard': 'Discard changes', 'settings.keepEditing': 'Keep editing', 'settings.unsaved': 'You have unsaved changes.',
        'settings.fragmentName': 'Name', 'settings.fragmentDescription': 'Description',
        'settings.fragmentInstruction': 'Generation instruction',
        'settings.kindDirection': 'Guidance', 'settings.kindStyle': 'Style', 'settings.builtin': 'built-in',
        'settings.fragmentOff': 'disabled', 'settings.fragmentUsed': 'in use', 'settings.copySuffix': '(copy)',
        'fragment.error.emptyName': 'Enter a name.', 'fragment.error.nameLimit': 'The name is too long.',
        'fragment.error.descriptionLimit': 'The description is too long.',
        'fragment.error.emptyInstruction': 'Enter a generation instruction.',
        'fragment.error.instructionLimit': 'The instruction is too long.',
        'fragment.error.unknownVariable': 'The instruction contains an unknown variable; use one of the listed variables.',
        'fragment.error.duplicate': 'An entry with the same id already exists in this kind.',
        'fragment.error.fragmentsLimit': 'The custom entry limit is reached.',
        'fragment.error.invalid': 'The entry is incomplete.', 'fragment.error.inUse': 'This entry is in use; pick another one in the selector below before deleting it.',
        'fragment.error.save': 'Saving failed. Try again.',
        'seed.natural-followup': 'Natural continuation', 'seed.challenge': 'Challenge',
        'seed.alternative': 'Alternative path', 'seed.action': 'Next action',
        'seed.concise': 'Concise', 'seed.precise': 'Precise',
        'settings.group.optimize': 'Optimization strategy', 'settings.optimizeStrategy': 'Direction',
        'settings.optimizeClarify': 'Clarify only', 'settings.optimizeExpand': 'Faithful expand',
        'settings.optimizeHint': 'Clarify only removes ambiguity and barely rewrites. Faithful expand improves wording and makes already-implied details explicit without adding goals or acceptance criteria.',
        'settings.followSession': 'Use the session model',
        'settings.loading': 'Loading models…', 'settings.modelsError': 'Could not load the model list.',
        'settings.modelsEmpty': 'No models are available.', 'settings.unbound': 'Unbound',
        'settings.saveFailed': 'Saving the setting failed. Try again.',
        'error.no-model': 'This session has no model yet. Pick one in the composer first.',
        'error.model-unavailable': 'The model is unavailable. Check the DSH model settings or the auxiliary model in Prompt assist.',
        'error.invalid-output': 'The model returned an unsupported format. Try again.',
        'error.limit': 'The output exceeded the length limit. Shorten the text and retry.',
        'error.timeout': 'The request timed out. Try again.',
        'error.provider-error': 'The model request failed. Try again.',
        'error.request-rejected': 'The request was rejected before any model call. Update the plugin or report this.',
        'error.empty': 'No usable result was produced.', 'error.stale': 'The content changed. Try again.',
        'error.unavailable': 'This action is not available right now.',
        'error.attachments': 'Continuation is unavailable while the draft has attachments.',
        'error.selection': 'Clear the selection before requesting a continuation.',
        'error.chips': 'The draft contains references, so whole-draft optimization is unavailable. Select text without references and try again.',
        'error.empty-draft': 'Type something first.', 'error.caret-moved': 'The caret moved. Trigger again.',
        'error.no-prefix': 'Place the caret after some draft text to continue.',
        'error.save-failed': 'Saving the setting failed. Try again.',
        'notice.auto-on': 'Automatic prompt prediction is on.', 'notice.auto-off': 'Automatic prompt prediction is off.',
        'error.predict-failed': 'Prompt prediction failed. Try again or check the settings.',
        'error.fragment-invalid': 'The selected guidance or style is unavailable. Pick another one in the settings.',
      });
      ctx.effect(() => installStyles(), 'prompt-assist: styles');
      ctx.effect(() => () => { bridge = undefined; configForm = undefined; shortcuts = undefined; notifyBridge(); });
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay', id: 'local-prompt-assist', order: 20, locale: NS,
      }, PromptComposer));
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'prompt-assist', order: 25, locale: NS,
        label: () => t('view.promptAssist'), inject: (sessionId) => ({ sessionId }),
      }, PromptAssistView));
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right', id: 'local-prompt-assist-optimize', order: 10, locale: NS,
      }, OptimizeButton));
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'prompt-assist', order: 50, locale: NS,
        label: () => t('settings.title'),
      }, SettingsPage));
      const command = (id, label, defaults) => ({
        id, label: () => t(label), aliases: [], defaults,
        regions: ['editable'], modals: [],
        resolve(context) {
          const sessionId = sessionIdFrom(context.target);
          const assist = sessionId ? registry.get(sessionId) : undefined;
          if (!assist) return { status: 'blocked', reason: 'no-session' };
          return { status: 'handled', run: () => { if (id.endsWith('.toggle-auto')) void assist.toggleAuto(); else assist.trigger(); } };
        },
      });
      const key = (code, modifiers) => ({ code, modifiers });
      // Web exposes three assignable defaults: Slash belongs to shortcuts.open and Period to the
      // optional inspector, so the manual trigger takes Comma and the auto-toggle stays unbound.
      const desktopAlt = code => ({ 'desktop:macos': key(code, ['primary', 'alt']),
        'desktop:windows': key(code, ['primary', 'alt']), 'desktop:linux': key(code, ['primary', 'alt']) });
      const webShift = code => ({ 'web:macos': key(code, ['primary', 'shift']),
        'web:windows': key(code, ['primary', 'shift']), 'web:linux': key(code, ['primary', 'shift']) });
      ctx.effect(() => registerCommand(ctx, command('dsh-prompt-assist.predict', 'command.predict', {
        ...desktopAlt('KeyJ'), ...webShift('Comma'),
      }), logger));
      ctx.effect(() => registerCommand(ctx, command('dsh-prompt-assist.toggle-auto', 'command.toggle', {
        ...desktopAlt('KeyK'),
      }), logger));
      await ctx.remote.$mount(remoteContribution);
      ctx.inject(['remote.localPromptAssist'], child => {
        bridge = child.get('remote.localPromptAssist');
        notifyBridge();
        child.effect(() => () => { bridge = undefined; notifyBridge(); });
      });
    },
  };
}
