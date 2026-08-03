# Spend Note

A one-screen spending logger. Type an amount, type a note, hit Save. Everything
else lives behind the menu button. Works with no internet — entries are stored on
the phone and uploaded automatically when the connection comes back.

- **Zero npm dependencies.** Plain Node's built-in `http`. Nothing to build,
  nothing to compile, nothing that can break on a shared host.
- **Login once.** Username only, no password. The token has no expiry, so the
  phone stays logged in until you tap Log out.
- **Two users**, each with a username and a display name. Every saved entry
  carries the name, so the log shows who spent what.

## 1. Set your users

**`server/users.json` is not in this repo, on purpose.** Login is username-only,
so a username is effectively a password — and this repository is public. The
real list lives only on the server.

Two ways to configure it. Either copy the example and edit it:

```bash
cp server/users.example.json server/users.json
```

```json
[
  { "username": "someone",      "name": "Their Name" },
  { "username": "someone-else", "name": "Their Name" }
]
```

…or set a `USERS` environment variable instead, which is easier on Hostinger
because it survives a redeploy:

```
USERS=[{"username":"someone","name":"Their Name"},{"username":"someone-else","name":"Their Name"}]
```

`USERS` wins if both are present. The username is what you type at login; the
name is what gets written to the log. The file is re-read on change — no restart
needed. Until one of the two is set, nobody can log in and the server says so on
startup.

## 2. Run it locally

```bash
npm start
```

Open http://localhost:3000.

## Currencies

**THB** and **MMK**. Tap the label under the amount to switch; your last choice
is remembered, and a fresh install starts on THB.

Each entry stores its own currency and the two are never mixed — history shows a
separate daily total per currency, because the app holds no exchange rate and
will not invent one.

To change the list, edit `CURRENCIES` in both
[`public/app.js`](public/app.js) and [`server/server.js`](server/server.js)
(the server rejects anything not on its list). First entry is the default.

## Liquid glass UI

The interface uses [`liquid-glass-component-kit`](https://github.com/h0rhay/liquid-glass-component-kit)
(MIT, by George Clark), vendored into
[`public/vendor/liquid-glass/`](public/vendor/liquid-glass/) — not linked from a
CDN, so the app still looks right with no internet.

**Why this one.** It was picked over the alternatives because of what this
project is: no build step, no npm dependencies, and it has to run offline on a
phone.

| Candidate | Verdict |
| --- | --- |
| `liquid-glass-component-kit` | **Chosen.** MIT, zero runtime deps, SVG + `backdrop-filter`, 4.3 KB ESM with no bare imports — the browser loads it directly. |
| `liquid-glass-js` | Rejected. Needs WebGL 2.0 plus continuous `html2canvas` page capture — heavy on battery for an app you open for five seconds, and its own roadmap still lists mobile optimisation as pending. |
| `nikdelvin/liquid-glass` | Rejected. Astro components; would force a build step onto a project that has none. |

**What it's applied to:** the Save and Continue buttons, the currency toggle,
the note field, the menu button and sync badge, the menu sheet, the login card,
and the sticky day headers in history. Deliberately *not* the amount — the
number stays plain so it is the first thing you see.

### The backdrop

Glass has to bend something, or it is just a grey rectangle.
[`public/glass.css`](public/glass.css) adds three slowly drifting colour fields
behind the whole app for it to refract. They are radial gradients rather than
blurred elements, so there is no filter pass, and the drift is transform-only.
It stops entirely under `prefers-reduced-motion: reduce`.

### Known limit on iPhone

On iOS you get frosted glass — blur, saturation, specular highlights, rim
light — but **not** the refraction wobble. Two independent reasons:

1. WebKit does not support SVG filters in `backdrop-filter`
   ([bug 245510](https://bugs.webkit.org/show_bug.cgi?id=245510)), so
   `feDisplacementMap` is ignored.
2. The library itself disables SVG filters on any mobile user agent.

Every liquid-glass library hits reason 1 — it is a browser limitation, not
something a different package would fix. Android Chrome gets the full effect.
Treat refraction as a bonus on desktop, not the point.

### Turning it down or off

All project-specific styling is in `public/glass.css`; `public/vendor/` is
unmodified so it can be updated cleanly. To remove the effect entirely, drop the
two `<link>` tags and the `.backdrop` div from `index.html` and the
`applyGlass()` call in `app.js` — the original flat UI is still underneath in
`styles.css`.

**One gotcha to know if you edit the UI:** the library injects its glass layer
as a *child* of the element, so calling `textContent` on a glassed element
deletes the glass. That is why the currency pill and the sync badge write into
inner `<span>`s instead.

After changing anything in `public/`, bump `CACHE` in `public/sw.js` or phones
will keep serving the old files.

## 3. Deploy on Hostinger

### Option A — hPanel Node.js app (shared / Cloud hosting)

1. Upload the whole folder to your account (File Manager or SFTP), e.g. to
   `/home/uXXXXXXXX/domains/yourdomain.com/spend-note`.
2. hPanel → **Website → Node.js**. Create an application:
   - **Application root:** the folder you uploaded
   - **Application startup file:** `app.js`
   - **Node version:** 18 or newer
   - **Application URL:** your domain or subdomain
3. Hit **Restart**. There is nothing to `npm install` — the dependency list is empty.

Hostinger injects `PORT`; the server reads it automatically.

### Option B — VPS

```bash
cd /var/www/spend-note
npm install -g pm2
PORT=3000 pm2 start app.js --name spend-note
pm2 save && pm2 startup
```

Then point nginx at it:

```nginx
server {
  server_name spend.yourdomain.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

Finish with `certbot --nginx -d spend.yourdomain.com`.

### HTTPS is required

A PWA will not install, and the service worker will not run, over plain `http://`
(except on `localhost`). Enable Hostinger's free SSL for the domain before you
install the app on your phone.

## 4. Install on the phone

- **Android / Chrome:** open the site → menu → *Add to Home screen*.
- **iPhone / Safari:** open the site → Share → *Add to Home Screen*.

Launch it from the home-screen icon and it runs full screen with no browser bars.

## How offline works

Saving writes to IndexedDB on the device first and only then tries the network —
so the app behaves identically with or without signal. Queued entries show as
`N to sync` in the corner and flush automatically when:

- the browser fires an `online` event,
- you reopen the app,
- or you tap **Sync now** in the menu.

Each entry carries a client-generated UUID and the server ignores an id it has
already stored, so a retry after a dropped connection can never double-count.
Deletes are queued the same way.

## Data

Entries are appended to `data/entries.ndjson` — one JSON object per line, plain
text, easy to back up or read with any tool:

```json
{"op":"put","entry":{"id":"…","amount":2500,"note":"lunch","username":"lynn","name":"Lynn","createdAt":"2026-08-03T04:12:09.512Z"}}
```

Back it up by copying that one file. `data/secret.key` is the token-signing key —
keep it, or everyone gets logged out when it changes.

**Export CSV** in the menu downloads whatever the device has cached, for Sheets
or Excel.

## Security note

Login is username-only, exactly as specified — which means anyone who knows the
URL and a username can post entries. That's fine for a private URL shared between
two people. If you want a lock on it, set a shared passcode before starting:

```bash
APP_PASSCODE=your-secret npm start
```

The login screen then asks for it automatically. On Hostinger, add `APP_PASSCODE`
as an environment variable in the Node.js app settings.

## API

| Method | Path                 | Purpose                                       |
| ------ | -------------------- | --------------------------------------------- |
| POST   | `/api/login`         | `{username, passcode?}` → `{token, username, name}` |
| GET    | `/api/config`        | whether a passcode is required                |
| GET    | `/api/me`            | current user                                  |
| GET    | `/api/entries`       | recent entries, newest first                  |
| POST   | `/api/entries`       | batch upsert / delete (the offline flush)     |
| DELETE | `/api/entries/:id`   | delete one entry                              |
| GET    | `/api/health`        | uptime check + entry count                    |

All except `login`, `config` and `health` need `Authorization: Bearer <token>`.
