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
| Messages | `.alert` + `-ok/-error/-warn/-info` (flash messages at the top of the page); new-notification toast = `.notif-toast` (bottom right, `NotificationCenter` only) |
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
  log out, and the notification bell (`.notif-bell` + `.notif-badge`, `components/NotificationCenter.tsx`). There is no account button; do not add look-alikes without a real feature.
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

## Customer proforma (3.37.0)

- `/admin/muhasebe/cam/proforma` (opened from Cam Tahsilat): four stacked cards — customer select, future loading days
  (`.chips` with checkboxes), preview (`.load-table.confirm-table`: `tr.group-total` = loading day, `tr.sub` = order,
  `tr.sub.glass-row` = line; excluded orders with reasons; `.stats.stats-money` totals; `FxInfo` + manual-rate form),
  and the batch list (`.acc-table`, status badge, retry / void for failed batches).
- Cam Tahsilat lists a customer proforma once: order links + `.cell-note` with the loading days. An order covered by a
  customer proforma shows an `.alert-info` note in Finans / FGO instead of document buttons.

## Loading invoice (3.38.0)

- Loadings → confirmed day → `.card#faturalama` (Admin only, below the confirmation card): one
  `section.fx-block.bill-customer` per customer; each open invoice group is a `.bill-group` (chain / direct note, the
  same `.load-table.confirm-table` as the confirmation: `tr.sub` = order, `tr.sub.glass-row` = FGO line,
  `tr.bill-storno` = advance offset, `.stats.stats-money` totals, `FxInfo`, problem `.alert-warn`s, then the action
  row: "Avans faturası kes" (`btn-primary`) and "Fatura oluştur" (`btn-success`), both through `ConfirmButton`).
  Issued / queued / failed invoices are `.bill-issued` lines with status + payment badges.
- Customer proforma batch list: paid / advanced note (`.cell-note`) and the advance button in the actions cell.
- Cam Tahsilat: every document of a customer chain shows its order links and a `.cell-note` (loading days / confirmed
  loading day / source proforma); the chain is one group.

## Not-loaded glass and guest crates (3.39.0)

- Confirmation preview: `<details class="nl-box nl-entry" id="yuklenmeyen-giris">` inside the confirm form — a
  `.load-table.nl-table` with one row per glass line (planned qty, `input.nl-qty`, reason `<select>`, note).
- Confirmed day: `#yuklenmeyen.nl-box` under the confirmation table — planned / loaded / remaining / reason / next
  loading; replan status is a `.badge` link to the new day; Admin gets a date input + `ConfirmButton` ("Yeniden
  planla" / "Günü değiştir") and a "Vazgeç" link button in the `.nl-next` cell.
- Carried-forward rows and partially loaded orders carry a `.badge.badge-warn.replan-badge` on the order row.
- Guest crate: `.badge.badge-info.guest-badge` ("#15 · host") in the crate cell (customers get a plain `#15`
  `.badge-ok`); `.guest-box` under the customer's crate section holds the relation lines (`.guest-in` / `.guest-out`)
  and, for Admin, the `details.guest-assign` form (order select, crate select, `ConfirmButton`).

## Loading correction, partial replan, order advance (3.40.0)

- Confirmed day card (`#onay`): a `.badge-warn` "Düzeltildi #n" next to the title once corrected; `#gecerli-durum`
  (`.alert-info`) says the table is the CURRENT EFFECTIVE state. History is a `<details class="nl-box"
  id="duzeltme-gecmisi">`: the original confirmation table (same `.confirm-table`) followed by one `.correction-rev`
  block per revision (who / when / reason / `before → after` list). Never mix the two: the top table is effective,
  the history holds the original.
- "Düzelt" (Admin): `#duzelt.nl-box` — entry form in `<details class="nl-entry" id="duzelt-giris">` (`.nl-table`, one
  row per glass scope: confirmed / loaded / not loaded, `input.nl-qty`, reason `<select>`, note) + mandatory reason
  input; then the server-rendered preview `#duzelt-onizleme` (before / after table, affected replans, financial
  impact via `ImpactNote`) with the save `ConfirmButton`. A blocked correction shows `#duzelt-engel` (`.alert-error`).
- Financial impact (`ImpactNote`, `app/(panel)/yuklemeler/ImpactNote.tsx`): plain `.impact-line` for informational
  states; `.alert.alert-error.impact-line` with "MUHASEBE İŞLEMİ GEREKLİ" for `UNDER_INVOICED` / `OVER_INVOICED`.
  Reused in the billing card (`#faturalama`) under the issued invoice; supplier page marks the day with a
  `.badge-danger` + `.cell-note`.
- Partial replan (`#yuklenmeyen`): each replan is its own `.nl-replan` block (badge "N adet → day", move form, cancel);
  remaining free quantity as `.nl-free`; the new-replan form is `form.nl-new` (quantity `input.nl-qty`, default =
  free remainder, + date).
- Order finance card (`#finans`): `#avans-durumu.fx-block` shows "FGO tahsilatı / Avansı kesilen / Avansı kesilecek"
  (required amount as `.badge-warn` when > 0); `#fatura-engeli` (`.alert-warn`) when loaded and an advance is
  required. There is no payment amount input (payment is read from FGO only).

## Notifications (3.41.0)

- Top bar: `.notif-bell` (38 px round button, bell icon) with `.notif-badge` (danger pill, 1…99 / 99+). Dropdown
  `.notif-panel` (380 px, `--shadow-md`): `.notif-head` (title + "mark all" link button), `.notif-list` of
  `.notif-item` (`.unread` = `--primary-soft` background, bold title, `.notif-read` dot button), `.notif-foot` with the
  sound `.notif-switch` (role=switch; `.on` = ok tones). On phones the panel is fixed under the top bar.
- Toast `.notif-toast`: fixed bottom right, 340 px, primary left border, head line "Notificare nouă / n notificări noi"
  + `.notif-close`; body is the single notification (linked `.notif-main`) or a 3-title summary (`.notif-many`) that
  opens the list. One toast per poll batch; auto-hides after 9 s. Never use it for flash messages — those stay `.alert`.
- Tab title prefix "(n) " is added by the component; pages keep their own `<title>`.

## Compensation, decisions card, order removal (3.42.0)

- Offer table (`.offer-view`): last column `td.actions` with a `.btn-link` "Kırık / Telafi" on physical glass rows only;
  `badge-warn` "TELAFİ" next to the description of compensation lines (internal users; also in the offer editor's
  `.line-actions`).
- Compensation form: one `.card.comp-form` (`#telafi`) directly under the offer table — no modal, no wizard pages.
  `.grid-2` (glass select + quantity), `.comp-history` (`.alert-warn`, earlier compensations of the line), price and
  destination as `fieldset.comp-choice` (price = `.chip` radios, destination = two `.comp-dest` rows), then
  `.comp-summary` (primary-soft box with a `.kv` table) and the `.comp-confirm` checkbox; the primary button stays
  disabled until the checkbox is ticked.
- "Önemli kararlar" card (`#kararlar`): `.section-head` with the create button; each decision is a `.note.comp-entry`
  (order no, TELAFİ badge, quantity, status badge; source, prices, destination, creator / date in `.small` / `.meta`).
  A pending decision shows the Admin approve / reject forms inline.
- "Siparişi sil" (`#sil`, `.remove-order`, Admin only): a `.btn-danger` opens the section; consequences, a `.check`
  confirmation and a `.btn-danger-solid` that is disabled until the box is ticked. Removed orders: `#silinen` card with a
  `details.removed-list` on the orders page (restore = `ConfirmButton primary`).

## Financial documents (3.43.0)

- Customer page "Documente financiare" (`/belgeler`): the standard `.page-head` + one `.card.card-flush` with a
  `table.doc-table` (type, number, date, orders, total, currency, payment `Badge`, `.actions` with a `.btn` "Vezi PDF")
  and a `.card-note`. Payment tones: unpaid = danger, partial = warn, paid = ok, replaced / unknown = muted. The row
  reached from a notification (`#doc-<id>`) is highlighted with `tr:target` (primary-soft). No charts, no totals row.
- Admin receivables table: one extra column `td.doc-mail` — e-mail state `Badge` (sent = ok, waiting = muted,
  failed = danger, no e-mail = warn; error / recipient in the `title`) and, below it, a `.btn-link` "E-postayı tekrar
  gönder" (`ConfirmButton`). No separate e-mail page.

## Left for the page-level phase

Done so far: tokens and shared classes (3.26.0); shell, dashboards and standard list pages (3.27.0);
order detail and offer editor (3.28.0); loadings and crates (3.29.0); drawing section and viewer (3.31.0);
customer new-order forms (3.32.0); accounting (3.33.0). Still to do, page by page:

- Profile order detail page:
  layout and hierarchy (the old TAKİP arrangement) — not redesigned yet; they only inherit the shared styles.
- ~250 inline `style={{…}}` uses in `.tsx` (mostly margins and widths) — move to classes when each page is touched.
- Old-system features that do not exist here and were not faked: "Hesabım" button,
  per-section search/sort/group controls on the panels, "act on behalf of customer" bar (Phase 9),
  offer header fields (company / project / delivery date inside the editor), offer lock ("Kilitle").
