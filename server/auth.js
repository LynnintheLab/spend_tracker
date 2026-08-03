// Username-only login backed by an HMAC-signed token. The token carries no
// expiry, so a phone stays logged in until you explicitly log out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.join(here, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

const SECRET = loadSecret();

// Optional shared passcode. Unset by default: login is username-only, exactly
// as asked. Set APP_PASSCODE if you ever want the URL to not be enough.
const PASSCODE = process.env.APP_PASSCODE || '';

let usersCache = null;
let usersMtime = 0;
let warned = false;

/**
 * Users come from the USERS env var if set, otherwise server/users.json.
 * users.json is deliberately NOT in git: with username-only login, a username
 * is a credential, and this repo is public.
 */
export function listUsers() {
  if (process.env.USERS) {
    try {
      return JSON.parse(process.env.USERS);
    } catch {
      if (!warned) {
        console.error('USERS env var is not valid JSON — falling back to users.json');
        warned = true;
      }
    }
  }
  try {
    const stat = fs.statSync(USERS_FILE);
    if (!usersCache || stat.mtimeMs !== usersMtime) {
      usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      usersMtime = stat.mtimeMs;
    }
  } catch {
    if (!usersCache && !warned) {
      console.error(
        'No users configured. Copy server/users.example.json to server/users.json, ' +
        'or set the USERS env var. Nobody can log in until you do.'
      );
      warned = true;
    }
    usersCache = usersCache || [];
  }
  return usersCache;
}

export function findUser(username) {
  if (typeof username !== 'string') return null;
  const key = username.trim().toLowerCase();
  if (!key) return null;
  return listUsers().find((u) => String(u.username).toLowerCase() === key) || null;
}

export function passcodeRequired() {
  return PASSCODE.length > 0;
}

export function passcodeOk(value) {
  if (!PASSCODE) return true;
  const a = Buffer.from(String(value ?? ''));
  const b = Buffer.from(PASSCODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function makeToken(username) {
  const payload = b64u(JSON.stringify({ u: username, iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

/** Returns the user record for a valid token, or null. */
export function readToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return findUser(u); // null if the user was removed from users.json
  } catch {
    return null;
  }
}
