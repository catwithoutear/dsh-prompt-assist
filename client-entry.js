/* Built with core.js and remote.js into the DSH module-loader artifact. */
function makeClient(React) {
  const h = React.createElement;
  const NS = 'local-prompt-assist';
  let bridge;
  const bridgeListeners = new Set();
  const notifyBridge = () => { for (const fn of bridgeListeners) fn(); };
  const bridgeSource = {
    getSnapshot: () => bridge,
    subscribe: fn => { bridgeListeners.add(fn); return () => bridgeListeners.delete(fn); },
  };
  const EMPTY = [];
  // The native overlay seat has height:0 and position:absolute. Only a ready
  // suggestion turns its owning card into a shared grid row: the preview sizes
  // that row while the empty editor remains above it for focus, caret and input.
  // This is scoped by our component marker and disappears with its stylesheet.
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
}`;

  function PromptComposer(props) {
    const { useInput, useSession, useProjection, inputActions, sessionId, t } = props;
    const api = React.useSyncExternalStore(bridgeSource.subscribe, bridgeSource.getSnapshot);
    const projection = useProjection(PROJECTION);
    const draft = useInput(s => s.draft);
    const phase = useInput(s => s.phase);
    const attachments = useInput(s => s.attachmentIds);
    const running = useSession(s => s.running);
    const removed = useSession(s => s.removed);
    const openState = useSession(s => s.openState);
    const root = React.useRef(null);
    const browse = React.useRef(null);
    const apiRef = React.useRef(api);
    apiRef.current = api;
    const controller = React.useMemo(() => createPreviewController({
      predict: (request, signal) => apiRef.current.predict(request, signal),
    }), [sessionId]);
    const preview = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const [visible, setVisible] = React.useState(false);
    const [composing, setComposing] = React.useState(false);
    const selection = useProjection('modelSelection');
    const route = selection?.next ?? selection?.lastUsed;
    const key = JSON.stringify([sessionId, projection?.endSeq, route?.provider, route?.model]);
    const valid = !running && !removed && openState === 'open'
      && projection?.eligible === true && projection.openTurn === null;
    const allowed = valid && phase === 'plain' && draft === '' && !(attachments?.length);
    const live = React.useRef();
    live.current = { draft, phase, inputActions, history: projection?.history ?? EMPTY,
      allowed, key, preview, composing, visible };

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
      controller.sync({ key, valid, visible: allowed && visible && !composing, ready: !!api,
        request: { sessionId, endSeq: projection?.endSeq } });
    }, [controller, key, valid, allowed, visible, composing, api, sessionId]);
    // pause cancels all owned work; React owns the snapshot subscription cleanup.
    // Keeping this reversible also handles effect setup/cleanup replay safely.
    React.useEffect(() => () => controller.pause(), [controller]);

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
      const dismiss = () => controller.dismiss();
      const onEdit = event => {
        if (!ownEditor(event.target)) return;
        browse.current = null;
        controller.pause();
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
        const candidate = state.preview?.key === state.key && (state.preview.text || state.preview.pending)
          ? state.preview : null;
        if (event.key === 'Escape' && candidate) {
          event.preventDefault(); event.stopPropagation(); dismiss(); return;
        }
        if (event.key === 'Tab' && state.allowed && candidate?.text) {
          // Selection + revision check prevents an asynchronous result overwriting typing.
          const span = state.inputActions.captureInsertion();
          if (state.inputActions.insertText(candidate.text, span)) {
            event.preventDefault(); event.stopPropagation(); dismiss();
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
        const next = browseHistory(active, state.draft, state.history, direction);
        if (!next) return;
        event.preventDefault(); event.stopPropagation();
        controller.pause();
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
    }, [controller, sessionId]);

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
  return {
    inject: ['slots', 'locale', 'remote'],
    async apply(ctx) {
      ctx.locale.register(NS, 'zh', { 'preview.label': '下一句建议', 'preview.accept': 'Tab 采纳 · Esc 忽略', 'preview.pending': '正在用当前会话模型生成建议…' });
      ctx.locale.register(NS, 'en', { 'preview.label': 'Suggested next prompt', 'preview.accept': 'Tab to accept · Esc to dismiss', 'preview.pending': 'Generating with this session’s model…' });
      ctx.effect(() => () => { bridge = undefined; notifyBridge(); });
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay', id: 'local-prompt-assist', order: 20, locale: NS,
      }, PromptComposer));
      await ctx.remote.$mount(remoteContribution);
      ctx.inject(['remote.localPromptAssist'], child => {
        bridge = child.get('remote.localPromptAssist');
        notifyBridge();
        child.effect(() => () => { bridge = undefined; notifyBridge(); });
      });
    },
  };
}
