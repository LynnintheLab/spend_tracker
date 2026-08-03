import { db } from './db.js';
import { applyLiquidGlass } from './vendor/liquid-glass/liquid-glass.js';
import { interactive } from './motion.js';

// Tap the label under the amount to switch. First entry in the list is the
// default; add or rename here and the server list in server/server.js to match.
const CURRENCIES = ['THB', 'MMK'];

const SESSION_KEY = 'spend-note.session';
const CURRENCY_KEY = 'spend-note.currency';
const $ = (id) => document.getElementById(id);

const el = {
  login: $('login'), loginForm: $('loginForm'), loginUser: $('loginUser'),
  loginPass: $('loginPass'), loginError: $('loginError'),
  home: $('home'), entryForm: $('entryForm'), amount: $('amount'), note: $('note'),
  saveBtn: $('saveBtn'), currency: $('currency'), currencyLabel: $('currencyLabel'),
  pending: $('pending'), pendingText: $('pendingText'),
  menuBtn: $('menuBtn'), sheet: $('sheet'), sheetClose: $('sheetClose'),
  whoName: $('whoName'), whoStatus: $('whoStatus'),
  history: $('history'), historyList: $('historyList'), historyBack: $('historyBack'),
  toast: $('toast'),
};

let session = null;
let syncing = false;

/* --------------------------------------------------------------------- glass */

/**
 * Glass a node once. Re-applying would stack a second overlay inside it.
 * `press` opts the node into the pointer-tracking highlight and press-spring;
 * panels get the glass but not the motion — only things you tap should move.
 */
function glass(node, intensity = 'normal', press = 0) {
  if (!node || node.dataset.glassed) return;
  node.dataset.glassed = '1';
  applyLiquidGlass(node, { intensity });
  if (press) interactive(node, press);
}

function applyGlass() {
  // Big surfaces compress less than small ones — a 4% squash on a full-width
  // button reads the same as 8% on a 44px circle.
  glass(el.saveBtn, 'strong', 0.97);
  glass(el.loginForm.querySelector('.btn.primary'), 'strong', 0.97);
  glass(el.currency, 'subtle', 0.92);
  glass(el.note, 'subtle');
  glass(el.menuBtn, 'subtle', 0.9);
  glass(el.pending, 'subtle');
  glass(el.historyBack, 'subtle', 0.9);
  glass(el.loginUser, 'subtle');
  glass(el.loginPass, 'subtle');
  // el.sheet is the dimming backdrop; the panel itself is the nav inside it.
  glass(document.querySelector('.sheet'));
  glass(document.querySelector('.login-card'), 'subtle');
  for (const item of document.querySelectorAll('.sheet-item')) interactive(item, 0.985);
}

/* ------------------------------------------------------------------ currency */

// Sticky: whichever you used last is preselected next time, so a run of
// entries in one country doesn't mean tapping the toggle every single time.
function currentCurrency() {
  const saved = localStorage.getItem(CURRENCY_KEY);
  return CURRENCIES.includes(saved) ? saved : CURRENCIES[0];
}

function setCurrency(code) {
  localStorage.setItem(CURRENCY_KEY, code);
  el.currencyLabel.textContent = code;
}

/* ------------------------------------------------------------------ session */

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(s) {
  session = s;
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

function clearSession() {
  session = null;
  localStorage.removeItem(SESSION_KEY);
}

/* --------------------------------------------------------------------- api */

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && session) {
    // Token no longer valid (user removed, or secret rotated).
    clearSession();
    show('login');
    throw new Error('Session expired — log in again');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------------------------------------------------------- ui helpers */

function show(name) {
  for (const screen of ['login', 'home', 'history']) el[screen].hidden = screen !== name;
  if (name === 'home') setTimeout(() => el.amount.focus({ preventScroll: true }), 50);
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1900);
}

const money = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt = (n) => money.format(n);

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(key) {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

const timeLabel = (iso) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/* ------------------------------------------------------------------- saving */

async function refreshPendingBadge() {
  const pending = await db.pending();
  if (pending.length) {
    el.pending.hidden = false;
    el.pendingText.textContent = `${pending.length} to sync`;
  } else {
    el.pending.hidden = true;
  }
  return pending.length;
}

el.entryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const amount = Number(el.amount.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    el.amount.focus();
    return;
  }

  const entry = {
    id: crypto.randomUUID(),
    amount: Math.round(amount * 100) / 100,
    currency: currentCurrency(),
    note: el.note.value.trim(),
    username: session.username,
    name: session.name,
    createdAt: new Date().toISOString(),
    synced: 0,
  };

  await db.put(entry);
  el.amount.value = '';
  el.note.value = '';
  el.amount.focus({ preventScroll: true });
  toast(`Saved ${fmt(entry.amount)} ${entry.currency}`);
  await refreshPendingBadge();
  sync(); // fire and forget — the entry is already safe on the device
});

// Keep the amount field to digits and a single decimal point.
el.amount.addEventListener('input', () => {
  const cleaned = el.amount.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  if (cleaned !== el.amount.value) el.amount.value = cleaned;
});
el.amount.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.note.focus(); }
});

el.currency.addEventListener('click', () => {
  const next = CURRENCIES[(CURRENCIES.indexOf(currentCurrency()) + 1) % CURRENCIES.length];
  setCurrency(next);
});

/* -------------------------------------------------------------------- sync */

async function sync({ silent = true } = {}) {
  if (syncing || !session) return false;
  const queue = await db.pending();
  if (!queue.length) return true;
  if (!navigator.onLine) {
    if (!silent) toast('Offline — will sync later');
    return false;
  }

  syncing = true;
  try {
    const payload = queue.map((e) =>
      e.deleted
        ? { id: e.id, deleted: true }
        : { id: e.id, amount: e.amount, currency: e.currency, note: e.note, createdAt: e.createdAt }
    );
    const { saved = [], failed = [] } = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({ entries: payload }),
    });

    const savedSet = new Set(saved);
    for (const entry of queue) {
      if (!savedSet.has(entry.id)) continue;
      if (entry.deleted) await db.remove(entry.id);
      else await db.put({ ...entry, synced: 1 });
    }
    // Anything the server rejected outright would retry forever; drop it and say so.
    for (const bad of failed) {
      if (bad.id) await db.remove(bad.id);
    }
    if (failed.length) toast(`${failed.length} entry could not be saved`);
    else if (!silent) toast(`Synced ${saved.length}`);

    await refreshPendingBadge();
    return true;
  } catch (err) {
    if (!silent) toast(err.message);
    return false;
  } finally {
    syncing = false;
  }
}

/** Pulls the shared log down so both users see each other's entries. */
const PULL_LIMIT = 300;

async function pull() {
  if (!navigator.onLine || !session) return;
  try {
    const { entries = [] } = await api(`/api/entries?limit=${PULL_LIMIT}`);
    const local = await db.all();
    const localPending = new Set(local.filter((e) => e.synced === 0).map((e) => e.id));

    const fresh = entries
      .filter((e) => !localPending.has(e.id)) // never resurrect a pending local delete
      .map((e) => ({ ...e, synced: 1 }));
    if (fresh.length) await db.putMany(fresh);

    // Drop entries the other phone deleted. Only prune inside the window the
    // server actually returned, so a truncated list can't wipe older history.
    const serverIds = new Set(entries.map((e) => e.id));
    const oldest = entries.length === PULL_LIMIT ? entries[entries.length - 1].createdAt : '';
    for (const item of local) {
      if (item.synced !== 1) continue;
      if (serverIds.has(item.id)) continue;
      if (item.createdAt < oldest) continue;
      await db.remove(item.id);
    }
  } catch {
    /* offline or server down — the local copy is still fine */
  }
}

/* ----------------------------------------------------------------- history */

async function renderHistory() {
  const rows = (await db.all()).filter((e) => !e.deleted);
  if (!rows.length) {
    el.historyList.innerHTML = '<p class="empty">No entries yet.</p>';
    return;
  }

  const groups = new Map();
  for (const row of rows) {
    const key = dayKey(row.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  el.historyList.replaceChildren();
  for (const [key, items] of groups) {
    // A day can mix currencies, so each one gets its own total. Never add
    // baht to kyat — there is no exchange rate anywhere in this app.
    const totals = new Map();
    for (const i of items) totals.set(i.currency, (totals.get(i.currency) || 0) + i.amount);
    const totalText = CURRENCIES
      .filter((c) => totals.has(c))
      .map((c) => `<span>${fmt(totals.get(c))} ${c}</span>`)
      .join('');

    const head = document.createElement('div');
    head.className = 'day';
    head.innerHTML = `<span>${dayLabel(key)}</span><span class="day-totals">${totalText}</span>`;
    el.historyList.append(head);
    glass(head, 'subtle'); // sticky, so rows blur as they pass under it

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'row' + (item.synced === 0 ? ' unsynced' : '');
      row.innerHTML = `
        <div class="row-main">
          <div class="row-note">${escapeHtml(item.note || '—')}</div>
          <div class="row-meta">${escapeHtml(item.name)} · ${timeLabel(item.createdAt)}</div>
        </div>
        <div class="row-amount">${fmt(item.amount)}<span class="row-cur">${escapeHtml(item.currency)}</span></div>
        <button class="row-del" aria-label="Delete entry">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>`;
      row.querySelector('.row-del').addEventListener('click', () => removeEntry(item));
      el.historyList.append(row);
    }
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function removeEntry(item) {
  if (!confirm(`Delete ${fmt(item.amount)} ${item.currency}${item.note ? ` · ${item.note}` : ''}?`)) return;
  if (item.synced === 0) {
    await db.remove(item.id); // never reached the server, just drop it
  } else {
    await db.put({ ...item, deleted: true, synced: 0 }); // queue the delete
  }
  await refreshPendingBadge();
  await renderHistory();
  sync();
}

/* -------------------------------------------------------------------- menu */

function openSheet() {
  el.whoName.textContent = session?.name || '';
  el.whoStatus.textContent = navigator.onLine ? 'Online' : 'Offline — entries are saved on this phone';
  el.sheet.hidden = false;
}
const closeSheet = () => { el.sheet.hidden = true; };

el.menuBtn.addEventListener('click', openSheet);
el.sheetClose.addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });

el.sheet.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  if (action === 'history') {
    closeSheet();
    await pull();
    await renderHistory();
    show('history');
  }
  if (action === 'sync') {
    closeSheet();
    const count = await refreshPendingBadge();
    if (!count) { await pull(); toast('Everything is synced'); return; }
    await sync({ silent: false });
  }
  if (action === 'export') {
    closeSheet();
    await exportCsv();
  }
  if (action === 'logout') {
    const count = await refreshPendingBadge();
    if (count && !confirm(`${count} entry not yet uploaded. Log out anyway?`)) return;
    closeSheet();
    clearSession();
    el.loginUser.value = '';
    show('login');
  }
});

el.historyBack.addEventListener('click', () => show('home'));

async function exportCsv() {
  const rows = (await db.all()).filter((e) => !e.deleted);
  const csv = [
    'date,time,name,username,amount,currency,note',
    ...rows.map((r) => {
      const d = new Date(r.createdAt);
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return [
        d.toLocaleDateString('en-CA'), d.toLocaleTimeString(undefined, { hour12: false }),
        cell(r.name), cell(r.username), r.amount, cell(r.currency), cell(r.note),
      ].join(',');
    }),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `spend-note-${dayKey(new Date().toISOString())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------------------- login */

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginError.textContent = '';
  const username = el.loginUser.value.trim();
  if (!username) return;

  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, passcode: el.loginPass.value }),
    });
    saveSession({ token: data.token, username: data.username, name: data.name });
    show('home');
    await pull();
    await refreshPendingBadge();
    await sync();
  } catch (err) {
    el.loginError.textContent = err.message;
  }
});

/* --------------------------------------------------------------------- boot */

window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});

async function boot() {
  applyGlass();
  setCurrency(currentCurrency());
  session = loadSession();

  if (session) {
    show('home');
    await refreshPendingBadge();
    pull();
    sync();
  } else {
    show('login');
    // Only ask for a passcode if the server is configured to want one.
    try {
      const cfg = await api('/api/config');
      if (cfg.passcodeRequired) el.loginPass.hidden = false;
    } catch { /* offline: username-only login is the default anyway */ }
    el.loginUser.focus();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
