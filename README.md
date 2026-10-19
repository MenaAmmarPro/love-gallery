# Our Gallery — Love for Mena

A photo timeline for the two of us. Add a picture, give it a caption and a
date, and it files itself into the right month. Part of the **Love for Mena**
collection.

**Live:** https://menaammarpro.github.io/love-gallery/

## What it does

- **Add photos** from your device — each one is downscaled on a canvas so it
  stays light
- **Caption + date** for every photo, with a date picker (defaults to today)
- A **timeline grouped by month**, newest month first, undated photos last
- A **lightbox** with previous/next, download and delete
- A **storage meter** so you can see how much room the gallery is using
- **Export/import captions** as JSON (the pictures themselves never leave the
  device and are never uploaded)
- Installable PWA with offline support

## How it works

The photos are stored as blobs in **IndexedDB** (`mena-gallery-db`); the
captions and dates live in `localStorage` under `mena-gallery`. Nothing is sent
anywhere — no tracking, no external requests. Export only ever writes the
captions, so you can keep them safe and re-import them later.

The pure logic (month grouping/sorting, downscale maths, byte formatting,
export/import) is exposed on `window.MenaGallery` and covered by
`test/harness.js`.

## Files

- `index.html` — the page
- `css/theme.css` — shared love-theme (copied from `_love-theme/`)
- `css/app.css` — page-specific styles
- `js/theme-main.js`, `js/effects.js` — shared behaviour/effects
- `js/app.js` — gallery logic
- `manifest.webmanifest`, `sw.js` — PWA
- `assets/` — favicon and icons
- `test/harness.js` — dependency-free Node tests (`node test/harness.js`)

## Run locally

```powershell
py -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy

Static site, deployed with GitHub Pages from `main`.

## License

Creative Commons BY-NC-ND 4.0 — see [`LICENSE`](LICENSE).
© 2026 Ammar (MenaAmmarPro). Made with care for Mena.
