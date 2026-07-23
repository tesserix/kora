# Tesserix Design System

A cross-platform design system for **web and React Native**, built on shadcn/ui + Radix primitives with an OKLCH token layer. This project packages the Tesserix foundations (tokens, type, color, iconography) and a set of reusable UI primitives, then applies them to a real product surface: **Kora**, an AI-first food-tracking mobile app.

## Sources

This system was reconstructed from the Tesserix design-system monorepo. Explore these to build more faithfully:

- **GitHub — `tesserix/design-system`**: https://github.com/tesserix/design-system
  - `packages/tokens/` — platform-agnostic tokens (colors, spacing, typography, radius, shadows, animations). 23 theme variants ship in the real package; we include **default** (slate); the brand primary is **Iris**, a custom OKLCH accent.
  - `packages/web/` — 130+ React + Tailwind components (shadcn-style, `cva` variants, `data-slot` attrs).
  - `packages/icons/` — Lucide wrapper + custom brand/social icons.
  - `packages/native/` — React Native components.
  - `apps/docs/`, `apps/storybook/` — documentation & Storybook.
- Docs: https://docs.tesserix.app · Storybook: https://ui.tesserix.app

> The published package supports **23 color themes** and **130+ web components**. This design system intentionally ships a focused, high-fidelity **core** (see Components below) plus one full product UI kit; the remaining families are listed under *Not yet built*.

## The product: Kora

Kora is a mobile app in the spirit of MyFitnessPal, but the core interaction is **AI capture** — snap a photo of a meal *or* tell the assistant ("**Otto**", reused from Tesserix's real `otto-widget` package) what you ate in plain language, and it logs the items and macros for you. Around that core sit modular add-ons: **weight, steps, water, medication reminders, sleep, and a fasting timer.**

Design direction (per the brief): **modern, futuristic, simple** — generous whitespace, minimal chrome, soft depth, and a monospace register for numeric/AI data. The app runs on **Iris** — a custom electric-indigo accent (`oklch(0.55 0.20 285)`), locked as the system default primary.

---

## Content fundamentals

How Tesserix / Kora writes copy:

- **Voice**: second person, direct, warm but efficient. "Snap it. Track it." · "Tell Otto what you ate." · "You're 240 kcal under goal."
- **Tone**: encouraging, never preachy or guilt-driven. Progress framed positively ("On track", "Nice streak") rather than negatively.
- **Casing**: **Sentence case** everywhere — buttons, titles, nav labels ("Log meal", not "Log Meal"). Uppercase is reserved for tiny overline labels with wide tracking (`STATS`, `TODAY`).
- **Numbers & data**: always in the **mono** register (`1,420 / 2,000 kcal`, `P 96g · C 148g · F 44g`). Units are lowercase and abbreviated (kcal, g, kg, mg, min).
- **Otto (the AI)**: speaks in first person, concise, confident but correctable — "I logged 2 eggs and toast — about 320 kcal. Tap to adjust." Always offers an easy edit path.
- **Length**: short. Headlines ≤ 5 words, helper text one line. Empty states are a single friendly sentence + one action.
- **Emoji**: **not used** in product UI. Meaning is carried by Lucide icons and color, never emoji.
- **Punctuation**: minimal; no exclamation-mark spam. A single "!" for a genuine win ("Logged!").

---

## Visual foundations

**Color.** OKLCH throughout. The default theme is a cool **slate** primary (`oklch(0.3752 0.0365 252.58)`) on white; the locked brand primary is **Iris**, a custom electric indigo (`oklch(0.55 0.20 285)`) applied as the unscoped `:root` default. Semantic status colors (success/warning/error/info/neutral) each ship as a **solid + muted pair** — muted backgrounds carry status without shouting. Two background colors max per surface. Full dark-mode token sets exist for both themes (`.dark`).

**Type.** No webfonts — Tesserix uses the **native system sans stack** (SF Pro / Segoe / Roboto), which reads crisp and modern on every device. A **monospace** stack carries all numbers, macros, and AI/data readouts (the "futuristic" register). Serif (Georgia) exists but is rarely used in product. Headings are **bold with tight tracking** (-0.025em); body is 400/1.5.

**Spacing.** 4px base scale. Cards and screens breathe — 16–24px internal padding, 24–32px between sections.

**Shape.** Base radius is **10px** (`--radius`); cards use **16px (xl)**, hero/sheet surfaces **24px (2xl)**, pills/rings are **full**. Nothing is sharp-cornered.

**Elevation.** Soft, diffuse shadows (`sm`→`2xl`). Cards sit on `shadow-lg` and lift to `shadow-xl` on hover/press. A **glass** card variant (translucent + backdrop-blur) is used over photography.

**Backgrounds.** Clean flat surfaces — **no aggressive gradients**. Depth comes from shadow and layering, not color washes. Food photography appears inside rounded image containers; the AI camera surface may use a subtle dark scrim + glass overlay.

**Motion.** Durations 150–300ms; default easing `ease-in-out` `cubic-bezier(0.4,0,0.2,1)`. Fades and gentle slides; ring/progress fills animate over 500ms `ease-out`. A `bounce` easing exists for playful confirmations but is used sparingly. No parallax, no gratuitous motion.

**States.** Hover = slight background darken (`/90`, `/80`) or shadow lift. Press/active = subtle scale-down or deeper token. Focus = **4px soft ring** at 20% opacity of the ring color plus a solid border (see Input). Disabled = 50% opacity, `not-allowed`.

**Borders.** Hairline `1px` on `--border` (a near-neutral tint of the theme hue). Inputs use a heavier **2px** border for tap clarity.

**Transparency & blur.** Used deliberately: glass cards, camera overlays, and sheet scrims. Not decorative elsewhere.

---

## Iconography

- **System**: [Lucide](https://lucide.dev) — the library Tesserix's `@tesserix/icons` package wraps. Outline style, **2px stroke**, 24px default. Size tokens: xs 12 · sm 16 · md 20 · lg 24 · xl 32 · 2xl 40.
- **Usage in this project**: load the Lucide **UMD** build from CDN (`unpkg.com/lucide`) and render via the `Icon` component (`<Icon name="camera" />`) or `data-lucide` attributes + `lucide.createIcons()`. No PNG icons, **no emoji**, no hand-rolled SVG glyphs.
- **Custom icons**: the real package also defines brand/social glyphs (Twitter, LinkedIn, Instagram, etc.) and a `TesserixLogo`. Those aren't reproduced here; use the brand PNGs in `assets/`.
- **Brand marks**: the **isometric-cube** Tesserix mark + wordmark (`assets/tesserix-logo-light.png`, `tesserix-icon.png`) are the real assets from the repo. A white/knockout wordmark (`tesserix-logo-dark.png`) exists for dark surfaces.

---

## Components

Core primitives, faithfully ported from the source `.tsx` (exact geometry — heights, radii, ring sizes — preserved). All consume the CSS token layer and render via `window.TesserixDesignSystem_275930`.

**Core** (`components/core/`)
- **Button** — 8 variants (default, secondary, outline, ghost, link, destructive, success, warning) × 7 sizes; loading state.
- **Badge** — status/label pill, 9 variants.
- **Card** (+ CardHeader, CardTitle, CardDescription, CardContent, CardFooter) — default + glass.
- **Input** — 2px border, soft focus ring, validity + helper/error states.
- **Avatar** — image or initials, 4 sizes.
- **Tag** — filter/token chip with optional dot + remove.
- **Separator** — hairline divider.
- **Icon** — Lucide glyph renderer.

**Forms** (`components/forms/`)
- **Switch** — toggle.
- **Checkbox** — check control.

**Feedback & Data** (`components/feedback/`)
- **Progress** — linear bar.
- **CircularProgress** — ring gauge (the calorie/macro ring).
- **Stat** — KPI block with trend delta.
- **Skeleton** — shimmer placeholder.
- **Callout** — inline status message.

**Not yet built** (present in the source, omitted from this focused core): Accordion, Alert/AlertDialog, Breadcrumb, Calendar/DatePicker, Combobox/Autocomplete, Command/CommandPalette, DataTable/DataGrid, Dialog/Drawer/Sheet/Modal, DropdownMenu/ContextMenu/Menubar, Pagination, Popover/Tooltip, Radio, Select/MultiSelect, Slider/RangeSlider, Stepper/Steps/Wizard, Tabs, Textarea, Timeline, Toast, Tour, charts, kanban, editors (rich-text/markdown/json/code), and ~90 more. Ask to continue and I'll build the next batch.

> **Intentional additions**: `Icon` (a thin Lucide renderer) and `Tag` are convenience wrappers not 1:1 with a single source file but backed by the source's Lucide dependency and chip patterns — added because the Kora UI kit needs them.

---

## UI kit — Kora (`ui_kits/plate/`)

A high-fidelity, click-through prototype of the Kora mobile app inside an iPhone frame, on the locked **Iris** theme. Eleven screens: onboarding, the **conversational Home feed** (Otto's coaching headline + capture bar; numbers demoted to a compact strip), **AI capture** (photo / voice / barcode / type with Otto), **AI Coach**, meal detail/edit, diary timeline, progress, **weekly Insights report**, **AI Meal Planner**, **Restaurant mode**, and the add-ons hub. Navigation uses an iOS-26-style **Liquid Glass floating dock**. `index.html` is the interactive prototype; `mockups.html` and `screens.html` are static galleries. Light/Dark and the capture flow are exposed as tweaks.

---

## Index / manifest

- `styles.css` — the single entry point (import manifest). Consumers link this.
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`, `radius.css`, `shadows.css`, `motion.css`.
- `components/` — `core/`, `forms/`, `feedback/` (each: `.jsx` + `.d.ts` + `.prompt.md` + a `@dsCard` HTML).
- `guidelines/` — foundation specimen cards (Colors, Type, Spacing, Brand).
- `ui_kits/plate/` — the Kora app UI kit.
- `assets/` — Tesserix logos + icon mark (real repo assets).
- `thumbnail.html` — homepage tile.
- `SKILL.md` — Agent-Skill wrapper for Claude Code.

## Caveats / substitutions

- **Fonts**: Tesserix ships **no webfonts** (native system stacks) — nothing to upload. The compiler flags `Cambria` (a serif *fallback*) as missing a `@font-face`; this is expected and safe — it's a system font.
- **Themes**: the locked default is **Iris** (custom OKLCH, not from the source's 23). Remaining named themes: `default` (slate) and `iris`.
- **Components**: a focused core is built; ~115 source families remain (see *Not yet built*).
