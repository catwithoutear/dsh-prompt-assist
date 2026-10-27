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
  const EMPTY_DRAFT = { kind: '', phase: 'idle', text: '', mode: '', reason: '' };
  const EMPTY_MODELS = { status: 'loading', providers: [] };
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
      set(key) {
        publish(key);
        clearTimeout(timer);
        timer = setTimeout(() => publish(''), 2600);
      },
      clear() { clearTimeout(timer); publish(''); },
      dispose() { clearTimeout(timer); listeners.clear(); },
    };
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
          next.trigger();
          return;
        }
        if (!state.draftValid) { notices.set('error.unavailable'); return; }
        if (state.attachments?.length) { notices.set('error.attachments'); return; }
        if (!bridge) { notices.set('error.unavailable'); return; }
        const span = state.inputActions.captureInsertion();
        if (span.start !== span.end) { notices.set('error.selection'); return; }
        capture = { kind: 'continuation', span, rev: span.draftRev, at: span.start };
        draft.startContinuation({ sessionId, endSeq: state.endSeq,
          prefix: state.draft.slice(0, span.start), suffix: state.draft.slice(span.end) });
      },
      optimize() {
        const state = live;
        if (!state) return;
        if (state.phase !== 'plain' || state.composing || !state.draftValid) {
          notices.set('error.unavailable');
          return;
        }
        if (!state.draft) { notices.set('error.empty-draft'); return; }
        let span = staged;
        staged = null;
        if (!span) span = state.inputActions.captureInsertion();
        const start = span.start;
        const end = span.end;
        const whole = start === end;
        const text = whole ? state.draft : state.draft.slice(start, end);
        if (!text.trim()) { notices.set('error.empty-draft'); return; }
        const chipStart = whole ? 0 : start;
        const chipEnd = whole ? state.draft.length : end;
        const chips = (state.occurrences ?? []).some(item => item.offset < chipEnd && item.offset + item.length > chipStart);
        if (chips) { notices.set('error.chips'); return; }
        capture = { kind: 'optimize', span, rev: span.draftRev, whole, text };
        draft.startOptimize({ sessionId, endSeq: state.endSeq, text,
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
          if (!actions.insertText(snapshot.text, span)) { notices.set('error.stale'); return; }
          finish();
          return;
        }
        if (state.draftRev !== owned.rev) { notices.set('error.stale'); return; }
        const span = owned.whole
          ? { start: 0, end: state.draft.length, draftRev: owned.rev }
          : owned.span;
        if (!actions.insertText(snapshot.text, span)) { notices.set('error.stale'); return; }
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
.dsh-pa-dock{
  box-sizing:border-box;display:flex;gap:10px;align-items:flex-start;justify-content:space-between;
  padding:6px 10px 0 14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;
  max-height:180px;overflow:auto
}
.dsh-pa-dock-text{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;opacity:.8}
.dsh-pa-dock-actions{display:flex;gap:6px;flex-shrink:0;align-items:flex-start}
.dsh-pa-dock-hint{font-size:11px;opacity:.65;white-space:nowrap}
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
.dsh-pa-card .dsh-pa-select{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-module-platform,transparent))}
@media (hover:hover){
  .dsh-pa-select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
}
.dsh-pa-select:disabled{opacity:.5;cursor:default}
.dsh-pa-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-pa-select-wrap::after{content:"";position:absolute;right:14px;top:50%;width:7px;height:7px;
  border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;opacity:.55;
  transform:translateY(-70%) rotate(45deg);pointer-events:none}
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
`;

  function PromptComposer(props) {
    const { useInput, useSession, useProjection, inputActions, sessionId, t } = props;
    const api = React.useSyncExternalStore(bridgeSource.subscribe, bridgeSource.getSnapshot);
    const projection = useProjection(PROJECTION);
    const draft = useInput(s => s.draft);
    const draftRev = useInput(s => s.draftRev);
    const phase = useInput(s => s.phase);
    const attachments = useInput(s => s.attachmentIds);
    const occurrences = useInput(s => s.occurrences);
    const running = useSession(s => s.running);
    const removed = useSession(s => s.removed);
    const openState = useSession(s => s.openState);
    const root = React.useRef(null);
    const browse = React.useRef(null);
    const apiRef = React.useRef(api);
    apiRef.current = api;
    const assist = React.useMemo(() => createSessionAssist(sessionId), [sessionId]);
    const preview = React.useSyncExternalStore(assist.next.subscribe, assist.next.getSnapshot);
    const [visible, setVisible] = React.useState(false);
    const [composing, setComposing] = React.useState(false);
    const selection = useProjection('modelSelection');
    const config = React.useSyncExternalStore(
      configForm ? configForm.subscribe : noopSubscribe,
      configForm ? configForm.getSnapshot : () => EMPTY_CONFIG,
    );
    const configValue = config?.value ?? {};
    const auto = configValue.autoPredict !== false;
    const selectedRoute = selection?.next ?? selection?.lastUsed;
    const routeProvider = configValue.provider || selectedRoute?.provider || '';
    const routeModel = configValue.model || selectedRoute?.model || '';
    const key = JSON.stringify([sessionId, projection?.endSeq, routeProvider, routeModel]);
    const valid = !running && !removed && openState === 'open'
      && projection?.eligible === true && projection.openTurn === null;
    const allowed = valid && phase === 'plain' && draft === '' && !(attachments?.length);
    const draftValid = !running && !removed && openState === 'open'
      && projection?.openTurn === null && phase === 'plain' && !composing && visible;
    const live = React.useRef();
    live.current = { draft, draftRev, phase, inputActions, occurrences, attachments,
      history: projection?.history ?? EMPTY, endSeq: projection?.endSeq, allowed, composing,
      visible, key,
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

    React.useEffect(() => {
      assist.next.sync({ key, valid, visible: allowed && visible && !composing, ready: !!api,
        auto, request: { sessionId, endSeq: projection?.endSeq } });
    }, [assist, key, valid, allowed, visible, composing, api, auto, projection?.endSeq, sessionId]);
    React.useEffect(() => {
      assist.draft.sync({ valid: draftValid, visible });
    }, [assist, draftValid, visible]);
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
        assist.next.pause();
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
    return h('div', { ref: root, 'data-prompt-assist-owner': sessionId,
      'data-prompt-assist-ready': shown?.text ? '' : undefined },
      shown?.text && h('div', { className: 'dsh-pa-preview', 'data-prompt-assist-preview': '',
        role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-text' }, shown.text),
        h('span', { className: 'dsh-pa-hint' }, t('preview.accept'))),
      h('style', null, CSS));
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

  function PromptDock(props) {
    const { sessionId, t } = props;
    const assist = useAssist(sessionId);
    const snapshot = React.useSyncExternalStore(
      assist ? assist.draft.subscribe : noopSubscribe,
      assist ? assist.draft.getSnapshot : () => EMPTY_DRAFT,
    );
    const notice = React.useSyncExternalStore(
      assist ? assist.notices.subscribe : noopSubscribe,
      assist ? assist.notices.getSnapshot : () => '',
    );
    if (!assist) return null;
    if (notice) {
      return h('div', { className: 'dsh-pa-dock', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-dock-text' }, t(notice)));
    }
    if (snapshot.phase === 'idle') return null;
    if (snapshot.phase === 'pending') {
      return h('div', { className: 'dsh-pa-dock', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-dock-text' }, t('dock.pending')));
    }
    if (snapshot.phase === 'error') {
      return h('div', { className: 'dsh-pa-dock', role: 'alert' },
        h('span', { className: 'dsh-pa-dock-text dsh-pa-error' }, t(`error.${snapshot.reason}`)),
        h('span', { className: 'dsh-pa-dock-actions' },
          h('button', { type: 'button', className: 'dsh-pa-button', onPointerDown: e => e.preventDefault(),
            onClick: () => assist.dismissDraft() }, t('dock.close'))));
    }
    if (snapshot.kind === 'continuation') {
      return h('div', { className: 'dsh-pa-dock', role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'dsh-pa-dock-hint' }, `${t('dock.continuation')} · `),
        h('span', { className: 'dsh-pa-dock-text' }, snapshot.text),
        h('span', { className: 'dsh-pa-dock-hint' }, t('dock.hint')));
    }
    // Optimize preview: apply is explicit; questions never offer an apply button.
    return h('div', { className: 'dsh-pa-dock', role: 'status', 'aria-live': 'polite' },
      snapshot.mode === 'questions' && h('span', { className: 'dsh-pa-dock-hint' }, `${t('dock.questions')} · `),
      h('span', { className: 'dsh-pa-dock-text' }, snapshot.text),
      h('span', { className: 'dsh-pa-dock-actions' },
        snapshot.mode === 'replace' && h('button', { type: 'button', className: 'dsh-pa-button',
          onPointerDown: e => e.preventDefault(), onClick: () => assist.apply() }, t('dock.apply')),
        h('button', { type: 'button', className: 'dsh-pa-button', onPointerDown: e => e.preventDefault(),
          onClick: () => assist.dismissDraft() },
        snapshot.mode === 'replace' ? t('dock.cancel') : t('dock.close'))));
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
    const providerEntry = models.providers?.find(item => item.id === provider);
    const providers = models.providers ?? [];
    const shortcutRows = (catalog ?? [])
      .filter(row => row.id === 'dsh-prompt-assist.predict' || row.id === 'dsh-prompt-assist.toggle-auto');
    const setField = (field, next) => {
      void Promise.resolve(configForm.set(field, next)).then(ok => setSaveError(!ok), () => setSaveError(true));
    };
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
        'button.optimize': '优化', 'button.optimizeTitle': '按 /clarify 优化选中文本',
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
        'settings.followSession': '恢复跟随会话模型',
        'settings.loading': '正在读取模型列表…', 'settings.modelsError': '模型列表读取失败。',
        'settings.modelsEmpty': '没有可用的模型。', 'settings.unbound': '未绑定',
        'settings.saveFailed': '设置保存失败，请重试。',
        'error.no-model': '没有可用的模型，请检查 DSH 模型设置。',
        'error.model-unavailable': '辅助模型不可用，请检查“提示词助手”设置。',
        'error.skill-unavailable': '未找到 /clarify 技能，无法优化。',
        'error.invalid-output': '模型输出格式不符合要求，请重试。',
        'error.limit': '输出超出长度限制，请缩短文本后重试。',
        'error.timeout': '请求超时，请重试。', 'error.provider-error': '模型请求失败，请重试。',
        'error.empty': '没有可用的结果。', 'error.stale': '内容已变化，请重试。',
        'error.unavailable': '当前不能执行该操作。', 'error.attachments': '带附件的草稿暂不支持续写。',
        'error.selection': '请先取消选区再续写。', 'error.chips': '包含引用内容的草稿暂不支持优化。',
        'error.empty-draft': '请先输入内容。', 'error.caret-moved': '光标已移动，请重新触发。',
        'error.save-failed': '设置保存失败，请重试。',
        'notice.auto-on': '自动提示词预测已开启。', 'notice.auto-off': '自动提示词预测已关闭。',
        'error.predict-failed': '提示词预测失败，请重试或检查设置。',
      });
      ctx.locale.register(NS, 'en', {
        'preview.label': 'Suggested next prompt', 'preview.accept': 'Tab to accept · Esc to dismiss',
        'preview.pending': 'Generating with the session’s model…',
        'command.predict': 'Trigger prompt prediction', 'command.toggle': 'Toggle automatic prompt prediction',
        'dock.continuation': 'Continuation', 'dock.hint': 'Tab to insert · Esc to dismiss',
        'dock.pending': 'Generating…', 'dock.apply': 'Apply', 'dock.cancel': 'Cancel',
        'dock.close': 'Close', 'dock.questions': 'More information needed',
        'button.optimize': 'Optimize', 'button.optimizeTitle': 'Clarify the selected prompt with /clarify',
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
        'settings.followSession': 'Use the session model',
        'settings.loading': 'Loading models…', 'settings.modelsError': 'Could not load the model list.',
        'settings.modelsEmpty': 'No models are available.', 'settings.unbound': 'Unbound',
        'settings.saveFailed': 'Saving the setting failed. Try again.',
        'error.no-model': 'No model is available. Check the DSH model settings.',
        'error.model-unavailable': 'The auxiliary model is unavailable. Check the Prompt assist settings.',
        'error.skill-unavailable': 'The /clarify skill was not found, so optimization is unavailable.',
        'error.invalid-output': 'The model returned an unsupported format. Try again.',
        'error.limit': 'The output exceeded the length limit. Shorten the text and retry.',
        'error.timeout': 'The request timed out. Try again.',
        'error.provider-error': 'The model request failed. Try again.',
        'error.empty': 'No usable result was produced.', 'error.stale': 'The content changed. Try again.',
        'error.unavailable': 'This action is not available right now.',
        'error.attachments': 'Continuation is unavailable while the draft has attachments.',
        'error.selection': 'Clear the selection before requesting a continuation.',
        'error.chips': 'Optimization is unavailable while the draft contains references.',
        'error.empty-draft': 'Type something first.', 'error.caret-moved': 'The caret moved. Trigger again.',
        'error.save-failed': 'Saving the setting failed. Try again.',
        'notice.auto-on': 'Automatic prompt prediction is on.', 'notice.auto-off': 'Automatic prompt prediction is off.',
        'error.predict-failed': 'Prompt prediction failed. Try again or check the settings.',
      });
      ctx.effect(() => () => { bridge = undefined; configForm = undefined; shortcuts = undefined; notifyBridge(); });
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay', id: 'local-prompt-assist', order: 20, locale: NS,
      }, PromptComposer));
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock', id: 'local-prompt-assist-dock', order: 10, locale: NS,
      }, PromptDock));
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
