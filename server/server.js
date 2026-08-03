import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { putEntry, deleteEntry, listEntries, countEntries } from './store.js';
import { makeToken, readToken, findUser, listUsers, passcodeRequired, passcodeOk } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function auth(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return readToken(token);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Must match CURRENCIES in public/app.js. First one is the default.
const CURRENCIES = ['THB', 'MMK'];

/**
 * Normalises one incoming entry. The client owns the id and the timestamp
 * (an offline entry must keep the moment it was actually written, not the
 * moment it finally reached the server), but the identity always comes from
 * the token — never from the request body.
 */
function normalise(raw, user) {
  if (!raw || typeof raw !== 'object') return { error: 'entry must be an object' };
  const id = String(raw.id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return { error: 'invalid id' };

  const amount = Math.round(Number(raw.amount) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) return { error: 'invalid amount' };

  const asked = String(raw.currency ?? '').toUpperCase();
  if (asked && !CURRENCIES.includes(asked)) return { error: 'unknown currency' };
  const currency = asked || CURRENCIES[0];

  const note = String(raw.note ?? '').trim().slice(0, 500);
  const createdAt = ISO.test(String(raw.createdAt)) ? String(raw.createdAt) : new Date().toISOString();

  return {
    entry: {
      id,
      amount,
      currency,
      note,
      username: user.username,
      name: user.name,
      createdAt,
      receivedAt: new Date().toISOString(),
    },
  };
}

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, entries: countEntries() });
  }

  if (route === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const user = findUser(body.username);
    if (!user) return sendJson(res, 401, { error: 'Unknown username' });
    if (!passcodeOk(body.passcode)) return sendJson(res, 401, { error: 'Wrong passcode' });
    return sendJson(res, 200, {
      token: makeToken(user.username),
      username: user.username,
      name: user.name,
    });
  }

  // usersConfigured is a yes/no only — never the names themselves. It exists so
  // a deploy can be checked without guessing at the server's env.
  if (route === '/api/config') {
    return sendJson(res, 200, {
      passcodeRequired: passcodeRequired(),
      usersConfigured: listUsers().length > 0,
    });
  }

  const user = auth(req);
  if (!user) return sendJson(res, 401, { error: 'Not logged in' });

  if (route === '/api/me') {
    return sendJson(res, 200, { username: user.username, name: user.name });
  }

  if (route === '/api/entries' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 300;
    return sendJson(res, 200, { entries: listEntries({ limit }) });
  }

  // Batch upsert + delete. This is the offline queue flush: the client sends
  // everything it has pending and the server replies with the ids it accepted.
  if (route === '/api/entries' && req.method === 'POST') {
    const body = await readBody(req);
    const items = Array.isArray(body.entries) ? body.entries : [body];
    if (items.length > 500) return sendJson(res, 400, { error: 'too many entries' });

    const saved = [];
    const failed = [];
    for (const raw of items) {
      if (raw && raw.deleted) {
        const id = String(raw.id ?? '');
        if (id) {
          deleteEntry(id);
          saved.push(id);
        }
        continue;
      }
      const { entry, error } = normalise(raw, user);
      if (error) {
        failed.push({ id: raw?.id ?? null, error });
        continue;
      }
      putEntry(entry);
      saved.push(entry.id);
    }
    return sendJson(res, 200, { saved, failed });
  }

  if (route.startsWith('/api/entries/') && req.method === 'DELETE') {
    const id = decodeURIComponent(route.slice('/api/entries/'.length));
    deleteEntry(id);
    return sendJson(res, 200, { deleted: id });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // Unknown path: hand back the app shell so deep links still open.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return send(res, 404, 'Not found');
        send(res, 200, html, { 'Content-Type': MIME['.html'] });
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    // Only the icons get a long cache. App code must revalidate, otherwise a
    // deploy sits behind the browser cache for days; offline is the service
    // worker's job, not the HTTP cache's.
    const cache = url.pathname.startsWith('/icons/')
      ? 'public, max-age=604800, immutable'
      : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(filePath).pipe(res);
  });
}

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Bad request' });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`spend-note listening on http://${HOST}:${PORT}`);
  });
  return server;
}
