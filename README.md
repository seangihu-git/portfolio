# Sean Huynh — Portfolio

A static portfolio landing page with an animated halftone night-sky hero.

## Structure

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Design tokens (colors, fonts, spacing) and layout |
| `hero.js` | Canvas sky animation and per-letter font alternates |
| `fonts/` | Self-hosted display font (Default Lingo) |
| `vercel.json` | Caching and security headers for Vercel |

No build step and no dependencies.

## Run locally

ES modules need a server (opening the file directly won't load `hero.js`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Customize

- **Colors / fonts / spacing:** edit the tokens at the top of `styles.css`. The canvas reads its colors from the same tokens.
- **Animation:** edit `CONFIG` at the top of `hero.js` (cell size, shooting-star and twinkle rates, pointer repel).
- **Reduced motion:** visitors with "reduce motion" enabled see a still frame. The animation also pauses when the tab is hidden or the hero is scrolled off screen.

## Deploy

Hosted on Vercel from this GitHub repo. Every push to `main` deploys to production and every pull request gets a preview URL. Framework preset: **Other**, no build command, output directory `.` (repo root).
