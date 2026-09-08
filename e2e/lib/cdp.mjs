/* ===========================================================================
   A Chrome DevTools Protocol client, sized for driving this machine.
   ---------------------------------------------------------------------------
   Node 24 has WebSocket built in, so this needs nothing installed -- which is
   the point: the end-to-end suite has to be runnable from a clean checkout with
   the same `npm install` the app already needs.
   =========================================================================== */

/** One request/response channel over a CDP websocket. */
export function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        (listeners.get(msg.method) || []).forEach((fn) => fn(msg.params));
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    });
    ws.addEventListener('error', () => reject(new Error('CDP 連不上 ' + url)));
    /* A socket that closes with requests outstanding would otherwise hang the
       run until the test timeout, reporting nothing useful. */
    ws.addEventListener('close', () => {
      pending.forEach((p) => p.reject(new Error('CDP 連線在等待回應時關閉')));
      pending.clear();
    });

    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      },
      on(method, fn) {
        listeners.set(method, (listeners.get(method) || []).concat(fn));
      },
      close: () => ws.close()
    }));
  });
}

/**
 * Evaluate in the target and return the value.
 *
 * A thrown exception on the page comes back as a rejected promise here rather
 * than as an undefined result: a spec that silently reads undefined from a
 * broken expression passes for the wrong reason.
 */
export async function evaluate(cdp, expression, { timeout = 30000 } = {}) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout
  });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error((e.exception && (e.exception.description || e.exception.value)) || e.text);
  }
  return r.result.value;
}

/** Evaluate an async body: the source is wrapped, so `await` is available. */
export function run(cdp, body, opts) {
  return evaluate(cdp, `(async function () { ${body} })()`, opts);
}

export async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list 回應 ${res.status}`);
  return res.json();
}

/** Poll until `fn()` returns something truthy, or give up with a useful error. */
export async function until(fn, { timeout = 20000, every = 250, what = '條件' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待「${what}」逾時（${timeout}ms），最後看到：${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
