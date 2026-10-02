# GKH TAKİP — UI design rules

Read this before any UI work. The goal is one visual system: a change to a token or a shared class must
propagate to every role's screens. The look is the old TAKİP (v2.25) cleaned up — light, calm, industrial B2B.

## Where things live

| What | Where |
|---|---|
| Tokens and every shared style | `app/globals.css` (single stylesheet; sections 1–9 listed in its header) |
| App shell for all roles (sidebar, topbar, content) | `app/(panel)/layout.tsx` — menu items come from `lib/roles` + permissions |
| Sidebar links / collapse / "Hareketler" slot | `app/(panel)/NavLinks.tsx`, `components/Sidebar.tsx` |
| Logo + version | `components/BrandLogo.tsx` |
| Status badges | `components/StatusBadge.tsx` (`Badge`, `OrderBadge`, `DrawingBadge`, `OfferBadge`, `CustomerBadge`) |
| Confirmed actions | `components/ConfirmButton.tsx` |
| Login / first-login card | `app/AuthCard.tsx` |
| Error screen | `components/ErrorView.tsx` |

No UI framework, no CSS modules, no Tailwind. Do not add one. Do not create a second component or class for
something that already exists here — extend the existing one.

## Rules

1. **Tokens only.** Colours, font sizes, radii, shadows and spacing come from the `:root` tokens in
   `app/globals.css`. Never write a hex colour in a `.tsx` file or a new one-off value in CSS. If a token is
   missing, add it to section 1 and use it.
2. **Shared classes first.** Build screens from the primitives below. Add a new class only for a genuinely
   new pattern, in `globals.css`, next to its relatives.
3. **Inline `style` is for layout nudges only** (a margin, a width, `flex: 1`). Never colour, font size, border.
4. **Visible text** comes from `server/i18n/{tr,ro}` — never hard-coded (see CLAUDE.md).
5. **Styling never carries authorization or business meaning.** Hiding or recolouring is not a permission
   check; workflow stays in `server/`.

## Tokens (section 1 of `globals.css`)

- **Surfaces:** `--bg` app background (light warm grey) · `--sidebar-bg` · `--surface` white cards/topbar/inputs ·
  `--surface-2` table head, group rows, notes · `--surface-3` neutral chips.
- **Lines:** `--border` cards · `--border-strong` inputs and buttons · `--divider` table rows.
- **Text:** `--text` · `--text-2` labels · `--muted` descriptions, table heads · `--faint` hints, dates.
- **Brand:** `--primary` GKH blue (`#1c4b91`) + `--primary-hover`, `--primary-soft`, `--primary-border`, `--focus`.
- **Status:** `--ok`, `--warn`, `--danger`, `--purple`, each with `-soft` (background) and `-border`.
  `--warn-accent` marks "your turn" and the current step.
- **Shape:** `--radius` 12px cards · `--radius-sm` 8px controls · `--radius-pill`.
  Shadows are very light: `--shadow-xs/sm` at rest, `--shadow-md/lg` only for floating things (menus, dialogs).
- **Spacing:** `--sp-1 … --sp-8` (4 → 32px).
- **Layout:** `--sidebar-w`, `--content-max`.

## Typography

Inter (bundled, `@fontsource-variable/inter`), system UI as fallback. Line height 1.45.

| Use | Token | Size |
|---|---|---|
| Page title `h1` | `--fs-h1` | 25px / 700 |
| Section title `h2` | `--fs-h2` | 19px / 700 |
| Highlighted values | `--fs-value` | 16px |
| Body | `--fs-body` | 15px |
| Tables, form content, buttons | `--fs-table` | 14.5px |
| Labels | `--fs-sm` | 14px / 600 |
| Metadata, hints, badges, table heads | `--fs-meta` | 13px — nothing readable goes below this |

Numbers in tables use `.num` (right-aligned, tabular figures). Codes and file names use `.mono`.

## Colour meaning

- **Blue** = primary action, links, active navigation, selection.
- **Red** = destructive or critical only (delete, cancel, overdue, error). Never decoration.
- **Green** = done / approved / on time. **Amber** = waiting on someone / at risk. **Purple** = drawing in progress.
- **Grey** = neutral, not started, inactive.
- Colour never carries meaning alone: a badge always has text.

## Primitives

| Need | Use |
|---|---|
| Page header | `<div class="page-head"><h1>…</h1><p class="muted">…</p></div>` |
| Section | `.card`; table-only section `.card.card-flush` + `.card-head` (title + count `.badge`) |
| "Your turn" section | `.card.turn` |
| Buttons | `.btn` secondary · `.btn-primary` main action (one per group) · `.btn-danger` critical but reversible · `.btn-danger-solid` irreversible (delete/cancel) · `.btn-link` inline · `.btn-block` full width |
| Form | `<label>` + input/select/textarea (styled globally) · `.field` · `.hint` · `.grid` / `.grid-2` / `.grid-3` · `.check` · `.chips` |
| Table | `.table-wrap > table`; uppercase `th`; group rows `.group-row`; right column `td.actions`; key/value `.kv` or `dl.order-info` |
| Status | `Badge` from `components/StatusBadge.tsx` (`.badge` + `-ok/-warn/-info/-muted/-purple/-danger`) |
| Messages | `.alert` + `-ok/-error/-warn/-info` (flash messages at the top of the page; there is no toast component) |
| Dialog | `<dialog class="modal">` |
| Empty / waiting | `.empty` · `.loading` |
| Navigation in a page | `.tabs` · `.toolbar` |
| Counters | `.stats > .stat` (`.k` label, `.v` value) |
| Progress | `.stepper > .step` (`done` / `current` / `skipped`) |
| Files, notes, history | `.file-row` · `.note` (`.internal`) · `.timeline` |
| SLA | `.sla-ok` / `.sla-risk` / `.sla-over`, `.sla-chip` |

## Shell behaviour (do not break)

- Same shell for Admin, Sales, Drawing, Customer, Inspector; only the menu items differ.
- Desktop: `‹` hides the sidebar completely and the content widens; a `›` tab on the left edge reopens it
  (state in `localStorage`, applied before first paint). Narrow screens: the sidebar is a drawer, plus a chip row.
- The topbar always shows the user name with the role (and the company for customers) under it.
- Desktop-first, but every screen must work at 390px: grids collapse to one column, tables scroll inside
  `.table-wrap`.
- Keyboard focus is always visible (`:focus-visible`); respect `prefers-reduced-motion`.

## Left for the page-level phase

The foundation restyled the shared classes only. Still to do, page by page:

- Order detail, offer editor, drawing section and viewer, loadings/crates, profile order, accounting, admin pages:
  layout and hierarchy (the old TAKİP arrangement) — not redesigned yet.
- ~280 inline `style={{…}}` uses in `.tsx` (mostly margins and widths) — move to classes when each page is touched.
- Topbar extras of the old system (role pill on the right, notifications bell, "Hesabım") and the old sidebar
  header row ("TAKİP vX ‹") — markup changes, decide per page phase.
- Use `.btn-danger-solid` for irreversible actions and `.loading` for waits where pages currently use plain text.
- Table row hover and denser/looser table variants.
