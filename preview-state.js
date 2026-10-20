/** Owns one composer's candidate separately from its temporary visibility. */
export function createPreviewController({ predict, delay = 250 }) {
  let key, request, valid = false, visible = false, ready = false;
  let cached = '', settled = false, dismissed = false, disposed = false;
  let active;
  let snapshot = { key: undefined, text: '', pending: false };
  const listeners = new Set();
  function publish() {
    const canShow = valid && visible && !dismissed && !disposed;
    const next = { key, text: canShow ? cached : '', pending: canShow && !!active };
    if (next.key === snapshot.key && next.text === snapshot.text && next.pending === snapshot.pending) return;
    snapshot = next;
    for (const notify of listeners) notify();
  }
  function cancel() {
    if (!active) return;
    const owned = active;
    active = undefined;
    clearTimeout(owned.timer);
    owned.controller.abort();
  }
  function start() {
    if (disposed || !valid || !visible || !ready || settled || dismissed || active) return;
    const owned = { controller: new AbortController() };
    active = owned;
    owned.timer = setTimeout(async () => {
      try {
        const result = await predict(request, owned.controller.signal);
        // A canceled request must not publish, even if its adapter ignores abort.
        if (disposed || active !== owned || owned.controller.signal.aborted) return;
        active = undefined;
        const value = result?.ok ? result.value : undefined;
        if (value?.status === 'ready' && typeof value.text === 'string' && value.text) {
          cached = value.text;
          settled = true;
        } else {
          cached = '';
          // A stale cursor can be reconsidered on the next visibility transition;
          // real failures and empty results do not trigger automatic retries.
          settled = value?.status !== 'stale';
        }
        publish();
      } catch {
        if (disposed || active !== owned || owned.controller.signal.aborted) return;
        active = undefined;
        settled = true;
        publish();
      }
    }, delay);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify); },
    sync(next) {
      if (disposed) return;
      if (next.key !== key || !next.valid) {
        cancel();
        cached = '';
        settled = false;
        dismissed = false;
      }
      key = next.key;
      request = next.request;
      valid = next.valid;
      visible = next.visible;
      ready = next.ready;
      if (!valid || !visible || !ready) cancel();
      else start();
      publish();
    },
    // Typing, paste, history and composition hide the candidate, retaining it
    // for when the draft becomes empty again. Pending work is canceled instead.
    pause() {
      if (disposed) return;
      visible = false;
      cancel();
      publish();
    },
    // Escape and successful Tab acceptance consume it for this exact context.
    dismiss() {
      if (disposed) return;
      dismissed = true;
      cached = '';
      cancel();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      cached = '';
      listeners.clear();
    },
  };
}
