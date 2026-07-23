---
name: tesserix-design
description: Use this skill to generate well-branded interfaces and assets for Tesserix (and its Kora AI food-tracking app), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

Key files:
- `readme.md` — brand context, content fundamentals, visual foundations, iconography, component index.
- `styles.css` — single CSS entry point (link this); imports all token files in `tokens/`.
- `tokens/` — colors (OKLCH, default + emerald themes, semantic status), typography, spacing, radius, shadows, motion.
- `components/` — reusable primitives (`core/`, `forms/`, `feedback/`), each with `.jsx`, `.d.ts`, `.prompt.md`.
- `guidelines/` — foundation specimen cards.
- `ui_kits/kora/` — the Kora app UI kit (full interactive mobile prototype).
- `assets/` — Tesserix logos + isometric cube mark.

Foundations in one line: OKLCH color, native system-sans + mono-for-numbers type, 4px spacing, 10px base radius (16/24 for cards), soft diffuse shadows, Lucide icons (2px stroke), sentence-case copy, no emoji. Modern, futuristic, simple.
