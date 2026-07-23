# Kora Design System — monorepo integration

The Kora design system: tokens, components, the Kora app UI kit, and the reusable template.

## Where it lives
Placed at `design-system/` in the monorepo, alongside `apps/` (mobile), `api/` (backend), `infra/`, etc.

## Contents
- `tokens/` — OKLCH color, type, spacing, shadow tokens (Iris accent locked).
- `styles.css` — entry stylesheet (@imports the tokens).
- `components/` — core / forms / feedback / layout primitives (`.jsx` + `.d.ts` + `.prompt.md`).
- `ui_kits/kora/` — full interactive Kora app prototype (open `index.html`).
- `templates/kora/` — reusable starting-point template (`Kora.dc.html`).
- `guidelines/` — foundation specimen cards.
- `SKILL.md`, `readme.md` — authoring + usage docs.
- `_ds_bundle.js` / `_ds_manifest.json` — compiled bundle consumed by other tooling.

## Add it to the existing repo
```bash
# from the monorepo root, after unzipping this into ./design-system
git add design-system
git commit -m "Add Kora design system"
git push origin main   # origin = git@github.com:tesserix/kora.git
```
