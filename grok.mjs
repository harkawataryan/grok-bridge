// Drives the Grok Bot desktop app (Electron) through the Chrome DevTools Protocol.
// The app has no public API, so this talks to its chat UI: types into the
// prompt box, presses Enter, and reads transcript rows back out of the DOM.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

const PORT = Number(process.env.GROK_CDP_PORT || 9333);
const CDP = `http://127.0.0.1:${PORT}`;
const EXE = process.env.GROK_BOT_EXE ||
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Grok Bot', 'Grok Bot.exe');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- app lifecycle ----------

async function cdpUp() {
  try { const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
}

function grokRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Grok Bot.exe', '/NH'], { encoding: 'utf8' });
    return out.includes('Grok Bot.exe');
  } catch { return false; }
}

/** Make sure Grok Bot is running with the debug port open. Restarts it if it was started normally. */
export async function ensureApp() {
  if (await cdpUp()) return { restarted: false };
  let restarted = false;
  if (grokRunning()) {
    // Running without the debug flag: restart it with the flag (it keeps you signed in).
    try { execFileSync('taskkill', ['/IM', 'Grok Bot.exe', '/F'], { stdio: 'ignore' }); } catch {}
    restarted = true;
    for (let i = 0; i < 20 && grokRunning(); i++) await sleep(250);
  }
  spawn(EXE, [`--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpUp()) {
      // wait for the chat UI to render
      for (let j = 0; j < 40; j++) {
        try { if (await evaluate(`!!document.querySelector('.sand-prompt-field')`)) return { restarted, launched: true }; } catch {}
        await sleep(500);
      }
    }
  }
  throw new Error(`Could not start Grok Bot with the debug port (${EXE}).`);
}

// ---------- CDP connection ----------

let ws = null, nextId = 0;
const pending = new Map();

async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find(p => p.type === 'page' && p.url.includes('/renderer/index.html')) ||
               list.find(p => p.type === 'page');
  if (!page) throw new Error('Grok Bot window not found.');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    const p = pending.get(d.id);
    if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  };
  ws.onclose = () => { ws = null; for (const p of pending.values()) p.rej(new Error('CDP closed')); pending.clear(); };
}

async function call(method, params = {}) {
  await connect();
  return new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('Page script failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function key(k, code, vk, modifiers = 0, text) {
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
}

// Serialize all UI actions so two Claude tool calls never type over each other.
let chain = Promise.resolve();
export function exclusive(fn) {
  const run = chain.then(async () => { await ensureApp(); return fn(); });
  chain = run.catch(() => {});
  return run;
}

// ---------- page-side helpers (run inside the Grok Bot window) ----------

const PAGE_HELPERS = String.raw`
  const G = {
    scrollBottom() { const v = document.querySelector('.sand-virtual-transcript'); if (v) v.scrollTop = v.scrollHeight; },
    rows() {
      return [...document.querySelectorAll('.sand-transcript-row')].map(r => {
        const key = r.dataset.rowKey || '';
        const kind = r.dataset.role === 'user' ? 'user' : key.startsWith('event-') ? 'event' : 'bot';
        const prose = [...r.querySelectorAll('.sand-message-prose')].map(p => p.innerText.trim()).filter(Boolean);
        const time = (r.querySelector('.sand-row-timestamp')?.innerText || '').trim();
        let text = prose.join('\n\n');
        if (!text) {
          const lines = r.innerText.split('\n').map(s => s.trim()).filter(Boolean);
          if (kind !== 'event' && lines.length > 1) lines.shift(); // author name
          if (time && lines[lines.length - 1] === time) lines.pop();
          text = lines.join('\n');
        }
        return { index: Number(r.dataset.index), kind, text, time };
      }).sort((a, b) => a.index - b.index);
    },
    status() {
      const live = [...document.querySelectorAll('.sand-announce-polite,.sand-announce-assertive')].map(e => e.innerText.trim()).filter(Boolean).join(' / ');
      const bot = document.querySelector('.sand-chat-header__name')?.innerText.trim() || document.querySelector('.sand-agent-item[aria-current="page"]')?.getAttribute('aria-label') || '';
      return { bot, live, working: /\bis working\b/i.test(live) };
    },
    bots() {
      return [...document.querySelectorAll('.sand-agent-item')].map(a => ({
        id: a.dataset.agentId, name: (a.getAttribute('aria-label') || '').replace(/, Main Bot$/, ''),
        main: /, Main Bot$/.test(a.getAttribute('aria-label') || ''), active: a.getAttribute('aria-current') === 'page',
      }));
    },
  };
`;
const page = body => evaluate(`(async () => { ${PAGE_HELPERS} ${body} })()`);

// ---------- public operations ----------

export async function status() {
  return page(`return { ...G.status(), bots: G.bots() };`);
}

export async function listBots() {
  return page(`return G.bots();`);
}

export async function selectBot(nameOrId) {
  if (!nameOrId) return null;
  const res = await page(`
    const q = ${JSON.stringify(String(nameOrId).toLowerCase())};
    const items = [...document.querySelectorAll('.sand-agent-item')];
    const el = items.find(a => a.dataset.agentId === q) ||
               items.find(a => (a.getAttribute('aria-label')||'').toLowerCase().replace(/, main bot$/, '') === q) ||
               items.find(a => (a.getAttribute('aria-label')||'').toLowerCase().includes(q));
    if (!el) return { ok: false, bots: G.bots() };
    if (el.getAttribute('aria-current') !== 'page') el.click();
    return { ok: true, name: (el.getAttribute('aria-label')||'').replace(/, Main Bot$/, '') };
  `);
  if (!res.ok) throw new Error(`No bot matching "${nameOrId}". Bots: ${res.bots.map(b => b.name).join(', ')}`);
  await sleep(800);
  return res.name;
}

export async function readMessages(count = 10) {
  return page(`G.scrollBottom(); await new Promise(r => setTimeout(r, 300)); return { ...G.status(), messages: G.rows().slice(-${Number(count) || 10}) };`);
}

/** Wait until the bot stops working; return rows after `afterIndex`. */
export async function waitForReply(afterIndex, timeoutMs) {
  const start = Date.now();
  let sawActivity = false, lastSig = '', stableSince = Date.now();
  while (true) {
    const s = await page(`G.scrollBottom(); return { ...G.status(), rows: G.rows().filter(r => r.index > ${afterIndex}) };`);
    const botRows = s.rows.filter(r => r.kind !== 'user');
    if (s.working || botRows.length) sawActivity = true;
    const sig = JSON.stringify(s.rows.map(r => r.text));
    if (sig !== lastSig) { lastSig = sig; stableSince = Date.now(); }
    // Done: announcement says it replied (not working), there is a reply, and text stopped changing for 1.5s.
    if (sawActivity && !s.working && botRows.length && Date.now() - stableSince > 1500)
      return { done: true, bot: s.bot, messages: s.rows };
    if (Date.now() - start > timeoutMs)
      return { done: false, bot: s.bot, messages: s.rows };
    await sleep(700);
  }
}

export async function sendMessage(text, { bot, waitSeconds = 120 } = {}) {
  if (bot) await selectBot(bot);
  const before = await page(`G.scrollBottom(); const r = G.rows(); return { last: r.length ? r[r.length-1].index : -1, ...G.status() };`);
  await page(`const f = document.querySelector('.sand-prompt-field'); f.focus(); return true;`);
  // Select-all + delete any half-typed draft, then type line by line (Shift+Enter = newline).
  await key('a', 'KeyA', 65, 2);
  await key('Backspace', 'Backspace', 8);
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i) await key('Enter', 'Enter', 13, 8);
    if (lines[i]) await call('Input.insertText', { text: lines[i] });
  }
  await sleep(250);
  await key('Enter', 'Enter', 13, 0, '\r');
  // Confirm it was sent; fall back to clicking the send button.
  await sleep(700);
  const sent = await page(`return !document.querySelector('.sand-prompt-field').innerText.trim();`);
  if (!sent) {
    await page(`const b = [...document.querySelectorAll('.sand-prompt-form button')].find(b => b.getAttribute('aria-label') === 'Send message'); b && b.click(); return !!b;`);
    await sleep(700);
  }
  if (!waitSeconds) return { done: false, bot: before.bot, messages: [], afterIndex: before.last };
  const r = await waitForReply(before.last, waitSeconds * 1000);
  return { ...r, afterIndex: before.last };
}
