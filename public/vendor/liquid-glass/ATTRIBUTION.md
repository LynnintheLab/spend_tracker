# liquid-glass-component-kit

Vendored, unmodified, from npm — kept as local files rather than a CDN link so
the PWA still renders correctly with no internet.

- **Package:** `liquid-glass-component-kit@1.0.3`
- **Author:** George Clark
- **Source:** https://github.com/h0rhay/liquid-glass-component-kit
- **Licence:** MIT

Files here:

| file               | origin in the package | size   |
| ------------------ | --------------------- | ------ |
| `liquid-glass.js`  | `dist/liquid-glass.js` (ESM) | 4.3 KB |
| `liquid-glass.css` | `dist/style.css`      | 8.4 KB |

The ESM build has no bare import specifiers, so the browser loads it directly —
no bundler, no npm install, no build step, which is why this package was chosen
over the WebGL-based alternatives.

## To update

```bash
npm pack liquid-glass-component-kit
tar xzf liquid-glass-component-kit-*.tgz
cp package/dist/liquid-glass.js  public/vendor/liquid-glass/liquid-glass.js
cp package/dist/style.css        public/vendor/liquid-glass/liquid-glass.css
```

Then bump `CACHE` in `public/sw.js` so phones pick up the new files.

## Local tuning

Nothing in this folder is edited. All project-specific adjustments — the
backdrop the glass refracts, dark-theme tinting, and contrast fixes — live in
`public/glass.css`, which loads after the vendor stylesheet.
