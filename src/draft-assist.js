/** Owns the manual continuation / optimize preview separately from its request lifecycle. */
export function createDraftAssist({ call }) {
  let valid = false, visible = false, disposed = false;
  let active;
  let snapshot = { kind: '', phase: 'idle', text: '', mode: '', reason: '' };
  const listeners = new Set();
  function publish(next) {
    if (next.kind === snapshot.kind && next.phase === snapshot.phase && next.text === snapshot.text
      && next.mode === snapshot.mode && next.reason === snapshot.reason) return;
    snapshot = next;
    for (const notify of listeners) notify();
  }
  function clear() {
    if (active) {
      const owned = active;
      active = undefined;
      owned.controller.abort();
    }
    publish({ kind: '', phase: 'idle', text: '', mode: '', reason: '' });
  }
  async function start(kind, request) {
    if (disposed || !valid || !visible) return;
    clear();
    const owned = { kind, controller: new AbortController() };
    active = owned;
    publish({ kind, phase: 'pending', text: '', mode: '', reason: '' });
    try {
      const result = await call(kind, request, owned.controller.signal);
      // A canceled request must not publish, even if its adapter ignores abort.
      if (disposed || active !== owned || owned.controller.signal.aborted) return;
      active = undefined;
      const value = result?.ok ? result.value : undefined;
      if (value?.status === 'ready' && typeof value.text === 'string' && value.text) {
        publish({ kind, phase: 'ready', text: value.text, mode: value.mode ?? '', reason: 'none' });
        return;
      }
      if (value?.status === 'stale') {
        publish({ kind: '', phase: 'idle', text: '', mode: '', reason: '' });
        return;
      }
      publish({ kind, phase: 'error', text: '', mode: '', reason: value?.reason || 'provider-error' });
    } catch {
      if (disposed || active !== owned || owned.controller.signal.aborted) return;
      active = undefined;
      publish({ kind, phase: 'error', text: '', mode: '', reason: 'provider-error' });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify); },
    sync(next) {
      if (disposed) return;
      valid = next.valid === true;
      visible = next.visible === true;
      if (!valid || !visible) clear();
    },
    startContinuation(request) { return start('continuation', request); },
    startOptimize(request) { return start('optimize', request); },
    dismiss() { if (!disposed) clear(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) {
        const owned = active;
        active = undefined;
        owned.controller.abort();
      }
      listeners.clear();
    },
  };
}
