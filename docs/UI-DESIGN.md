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
| Page header | `<div class="page-head"><h1>…</h1><p class="muted">…</p></div>`; with actions on the right: `.page-head.row` (title block + `.row` of buttons) |
| Section | `.card`; list section `.card.card-flush` + `.card-head` (`<h2>` title + round count `.badge`; filters on the right with `.card-head.row`) + optional `.card-tools` (sort links) |
| "Your turn" section | `.card.turn` |
| Buttons | `.btn` secondary (outline) · `.btn-primary` main action (one per group) · `.btn-success` positive outcome (approve) · `.btn-danger` critical but reversible · `.btn-danger-solid` irreversible (delete/cancel) · `.btn-link` inline (`.danger` red) · `.btn-block` full width |
| Form | `<label>` + input/select/textarea (styled globally) · `.field` · `.hint` · `.grid` / `.grid-2` / `.grid-3` · `.check` · `.chips` |
| Table | `.table-wrap > table` (always wrap: narrow screens scroll sideways instead of crushing columns); uppercase `th`; group rows `.group-row`; right column `td.actions` (compact buttons); row hover is automatic; key/value `.kv` or `dl.order-info` |
| Status | `Badge` from `components/StatusBadge.tsx` (`.badge` + `-ok/-warn/-info/-muted/-purple/-danger`) |
| Messages | `.alert` + `-ok/-error/-warn/-info` (flash messages at the top of the page; there is no toast component) |
| Dialog | `<dialog class="modal">` |
| Empty / waiting | `.empty` (left-aligned sentence under the section title) · `.loading` |
| Navigation in a page | `.tabs` · `.toolbar` |
| Counters | `.stats > .stat` (`.k` label, `.v` value) |
| Progress | `.stepper > .step` (`done` / `current` / `skipped`) |
| Files, notes, history | `.file-row` · `.note` (`.internal`) · `.timeline` |
| SLA | `.sla-ok` / `.sla-risk` / `.sla-over`, `.sla-chip` |

## Shell behaviour (do not break)

- Same shell for Admin, Sales, Drawing, Customer, Inspector; only the menu items differ.
- Sidebar (old TAKİP layout): header row "TAKİP" + version (`VersionTag` — the only place the version comes
  from is `package.json`; never hard-code it) with the `‹` hide control, large GKH logo, tagline, sections,
  links, "Developed by" footer; on the order page the "Hareketler" slot sits at the bottom. No menu icons.
- Desktop: `‹` hides the sidebar completely and the content widens; a small `›` tab stays visible on the left
  edge to reopen it (state in `localStorage`, applied before first paint). Narrow screens: the sidebar is a
  drawer, plus a chip row.
- Topbar: user name (company under it for customers); the role is a pill on the right on desktop and sits
  under the name on narrow screens — exactly one of the two is visible. Right side: role pill, language,
  log out. There is no notification bell or account button; do not add look-alikes without a real feature.
- Desktop-first, but every screen must work at 390px: grids collapse to one column, tables scroll inside
  `.table-wrap`.
- Keyboard focus is always visible (`:focus-visible`); respect `prefers-reduced-motion`.

## Left for the page-level phase

Done so far: tokens and shared classes (3.26.0); shell, dashboards and standard list pages (3.27.0).
Still to do, page by page:

- Order detail, offer editor/table, drawing section and viewer, loading/crate detail, profile order, accounting:
  layout and hierarchy (the old TAKİP arrangement) — not redesigned yet; they only inherit the shared styles.
- ~270 inline `style={{…}}` uses in `.tsx` (mostly margins and widths) — move to classes when each page is touched.
- Apply `.btn-danger-solid` / `.btn-success` on those pages (cancel, delete, reject, approve) and `.loading`
  where pages show plain "loading" text.
- Old-system features that do not exist here and were not faked: notification bell, "Hesabım" button,
  per-section search/sort/group controls on the panels, "act on behalf of customer" bar (Phase 9).
