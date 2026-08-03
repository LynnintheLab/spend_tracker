// Append-only NDJSON store. No native modules, no npm packages — it just works
// wherever Node runs. Every write appends one line; the whole log is replayed
// into memory at boot and compacted when it gets too many dead lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(here, '..', 'data');
const LOG_FILE = path.join(DATA_DIR, 'entries.ndjson');

/** @type {Map<string, object>} live entries, keyed by client-generated id */
const entries = new Map();
/** ids that were deleted — kept so a replayed delete stays deleted */
const tombstones = new Set();
let lineCount = 0;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function replay() {
  ensureDir();
  if (!fs.existsSync(LOG_FILE)) return;
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lineCount++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // half-written final line after a crash — skip it
    }
    if (rec.op === 'del') {
      entries.delete(rec.id);
      tombstones.add(rec.id);
    } else if (rec.op === 'put' && rec.entry?.id) {
      if (tombstones.has(rec.entry.id)) continue;
      entries.set(rec.entry.id, rec.entry);
    }
  }
}

function append(record) {
  ensureDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
  lineCount++;
  maybeCompact();
}

function maybeCompact() {
  const live = entries.size;
  if (lineCount < 500 || lineCount < live * 3) return;
  const tmp = LOG_FILE + '.tmp';
  const body = [...entries.values()]
    .map((entry) => JSON.stringify({ op: 'put', entry }) + '\n')
    .join('');
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, LOG_FILE);
  lineCount = entries.size;
}

replay();

/**
 * Idempotent insert. The client generates the id, so replaying a queued
 * offline entry after a flaky connection can never create a duplicate.
 */
export function putEntry(entry) {
  if (tombstones.has(entry.id)) return entries.get(entry.id) ?? null;
  const existing = entries.get(entry.id);
  if (existing) return existing;
  entries.set(entry.id, entry);
  append({ op: 'put', entry });
  return entry;
}

export function deleteEntry(id) {
  const existed = entries.delete(id);
  tombstones.add(id);
  if (existed) append({ op: 'del', id });
  return existed;
}

export function listEntries({ limit = 200, since = null } = {}) {
  let all = [...entries.values()];
  if (since) all = all.filter((e) => e.createdAt > since);
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return all.slice(0, Math.min(limit, 1000));
}

export function countEntries() {
  return entries.size;
}

export { DATA_DIR };
