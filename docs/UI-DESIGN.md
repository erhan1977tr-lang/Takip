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

## Order detail and offer editor (3.28.0)

- Section order on the order page (all roles except Drawing): status + actions → customer files → notes →
  order information → drawings/approval → offer (editor or view) → finance / crates; history lives in the
  sidebar. Drawing team (3.31.0): customer files → drawings and approval (start + upload live here) → notes →
  order information; no stepper or action cards — status is shown as badges in the page head; no offer.
- Order information is `dl.order-info` (grey label column, value column, full width). Sub-headings inside a
  card use `<h3 class="sub-title">`; a card title with something on the right uses `.section-head`.
- Offer editor (`OfferEditor.tsx`): `.card.offer-card` → `.offer-wrap > table.offer-table` (bordered cells;
  the description column `th.c-desc` takes all spare width; column widths come from `.c-poz / .c-dim /
  .c-qty / .c-unit / .c-price`, never inline). Row actions sit under the description (`.line-actions`),
  the same-glass `+` is `.btn-dup`, delete is `.btn-del` in its own column, totals are the `tfoot` row.
  Tools live in one `.offer-tools` bar. The read-only offer uses `table.offer-view`.
- Never put `#teklif td…` rules in CSS: an ID selector silently overrides the editor's column rules
  (this caused the old description truncation).
- Buttons on this page: approve = `.btn-success`, cancel order = solid red, send back / request revision /
  clear table = `.btn-danger` (outline), everything else primary or secondary.

## Loadings and crates (3.29.0)

- Page header: title left, `.page-tools` right (day picker + "Nakliye Listesi" PDF + "Yükleme Dökümü Excel").
- Calendar: `.cal` / `.cal-day` (`.has` = day with loads, `.sel` = selected, `.other` = outside the month).
- Day detail: `.table-wrap.load-wrap > table.load-table`. Per customer: `tr.group-total` (header + totals,
  crate label for internal roles) → `tr.sub` order rows → `tr.crate-row` with a `<details>` holding the
  crate editor. Customers get the same table without the crate row and without other customers.
- Crate editor (`CrateEditor.tsx`): `.crate-editor` card → `.section-head` → `table.crate-table`
  (`.c-no / .c-dim / .c-kg / .c-note / .c-del` — no inline widths) → `.tool-bar`. Read-only roles get
  `table.crate-table.readonly`.
- `.tool-bar` (generic) and `.offer-tools` share one style; `.btn-del` is the row-delete button everywhere.

## Drawing section and viewer (3.31.0)

- Drawings card (`#cizim`): `.drawing-start` (take the job) → `.drawing-upload` (upload to draft) → versions
  (`.drawing-version`, draft = dashed). A draft shows only "Kontrol Et" (`.drawing-next`); there is no send
  button on the order page — sending lives on the viewer and the server requires the review proof.
- Viewer page (`siparisler/[id]/cizim/[drawingId]`): `.viewer` grid = `.viewer-main` (file select, tools,
  zoom, pages) + `.viewer-aside` (the decision card `.card.turn.viewer-decide` on top, then the marks list).
  The decision card is passed through the `side` prop of `DrawingViewer`: drafter → "Müşteriye gönder";
  customer → "Bu çizimi onayla" (`.btn-success`) + "Revizyon iste" (`.btn-danger`); revision screen → note +
  submit. Buttons sit in `.viewer-actions`. On narrow screens the aside drops below the drawing.
- Section filters inside a list card: `.card-tools` + `.card-filter` (e.g. loading day on approved drawings).
- Annotation colours are fixed (red / amber) so they stay readable on any drawing — the only place where
  colours are not tokens.

## Customer New Order forms (3.32.0)

- Page head: back link, title, one-line intro, then `.type-row` (order-type badge + "change type" link).
- Glass order (`NewOrderForm.tsx`), old TAKİP order: order info (`.alert.alert-info.ship-note` with the
  estimated loading date, then name + number in `.grid-2`) → files → glass → note → `.submit-bar`.
- Files: `label.dropzone` (the real `<input type="file" class="dropzone-input">` is visually hidden but is
  still the field the form submits) with `.dropzone-icon`; chosen files in `.upload-list` as `.file-row`s
  (ext chip, name, size, remove). Never build a second upload path — only the selection UI is custom.
- Glass: exactly one glass — `.glass-pick` (select + quantity with visible labels). No "add glass" control
  on the customer form (the Sales/Admin offer editor keeps its own "+ Cam ekle").
- Bottom bar on both forms: `.card.submit-bar.sticky-submit` with `ul.submit-check` (what is still missing;
  `li.done` when ready) on the left and the two buttons on the right.
- Legacy multi-glass draft (same route, `page.tsx`): `.alert-warn` + a card with `table.legacy-glass`
  (radio "keep" column, glass, quantity; `.legacy-actions` with the confirm button) + `OrderInfo` with the
  draft's other data. No form fields until the customer confirms one glass.
- Profile order (`ProfileOrderForm.tsx`): one `.card.card-flush` per category; `table.profile-table.profile-pick`
  with fixed column classes (`.c-thumb / .c-unit / .c-qty`) so unit and quantity line up across categories.

## Accounting (3.33.0)

- Receivables (`ReceivablesView.tsx`, Profil / Cam Tahsilat): `.page-head.row` (title + "FGO ile Güncelle" in
  `.page-tools`) → per currency one `.stats.stats-money` row (total / paid / remaining + open-document count;
  `.stat-ok / .stat-warn / .stat-danger / .stat-muted` colour the left bar) → `.card.card-flush` with `.card-head`
  (title + count), `.card-tools` status filter links, `table.acc-table`, and a `.card-note` footnote.
  Rows are grouped per order (`tr.grp-first` starts a group; order no and customer only on the first row).
  A proforma replaced by an invoice shows "—" and a muted badge instead of a red "unpaid" one.
- Supplier (`tedarikci/page.tsx`): summary table (one row per currency) → loading profitability (`tr.grp-first`
  per day; transport entries in `td.acc-entries` with a `<details>` add form) → factory account
  (`.stats.stats-money` balances, add-payment card with `form.acc-form`, payments table).
- Money columns are always `.num`; amounts in a currency column omit the currency suffix when the column or
  card already names it. Negative amounts use `.text-danger`. Secondary text inside a cell is `.cell-note`.
- `form.acc-form` is the one-line entry form (inputs at natural width, `.c-amount` right-aligned, `.c-note`
  takes the rest). `.card-sub` is the explanatory line under a `.card-head`.

## Loading confirmation (3.34.0)

- Lives on the loading page under the day detail: `.card#onay` (`LoadingConfirm.tsx`), never a separate page.
  `.section-head` = title + state badge (amber "Onaylanmadı" / green "Yükleme onaylandı").
- Preview and confirmed view share one table: `table.load-table.confirm-table` — `tr.group-total` (customer) →
  `tr.sub` (order) → `tr.sub.glass-row` (glass, indented, smaller) → `tfoot` totals. Money columns only for Admin.
- The confirm action sits in a `.tool-bar.confirm-bar` (note input left, `ConfirmButton success` right). It is
  irreversible, so it always goes through the confirm dialog; warnings (skipped orders, missing cost) are
  `.alert-warn` above the table.
- Supplier page: each loading row carries a state badge (`.cell-badges`: green "onaylı" / grey "planlanan",
  amber "maliyet eksik"); the missing-cost entry card is `#maliyet-gir` with one `form.acc-form` per line.

## Exchange-rate policy (3.35.0)

- Customer edit page (`/admin/firms/[id]`): section "Kur politikası / Politica curs valutar" inside the existing form
  (`FxPolicyFields`: select + percentage field shown only for "BNR + %"), then a separate card `#kur-bugun` with today's
  rate for the saved policy.
- Rate details are always shown with `components/FxInfo.tsx` (`.kv.fx-info`: policy → base rate → percent → applied
  rate → source → rate date). A manual rate carries a `warn` badge (ELLE / MANUAL). When a rate cannot be resolved use
  `FxUnavailableNote` (`.alert-warn.fx-unavailable`) — never show another rate in its place.
- Profile order (Admin only): the stored snapshot is shown with the same component in the FGO block.
- Glass order → Finans / FGO: `.fx-block` with the same component (today's rate before the document, stored snapshot
  after it); the optional manual-rate input sits in the document form (`.fx-manual`).

## Left for the page-level phase

Done so far: tokens and shared classes (3.26.0); shell, dashboards and standard list pages (3.27.0);
order detail and offer editor (3.28.0); loadings and crates (3.29.0); drawing section and viewer (3.31.0);
customer new-order forms (3.32.0); accounting (3.33.0). Still to do, page by page:

- Profile order detail page:
  layout and hierarchy (the old TAKİP arrangement) — not redesigned yet; they only inherit the shared styles.
- ~250 inline `style={{…}}` uses in `.tsx` (mostly margins and widths) — move to classes when each page is touched.
- Old-system features that do not exist here and were not faked: notification bell, "Hesabım" button,
  per-section search/sort/group controls on the panels, "act on behalf of customer" bar (Phase 9),
  offer header fields (company / project / delivery date inside the editor), offer lock ("Kilitle"),
  "Özel durum" and "Siparişi sil".
