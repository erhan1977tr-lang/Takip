# GKH TAKİP — UI design rules

Read this before any UI work. The goal is one visual system: a change to a token or a shared class must
propagate to every role's screens. The look is the old TAKİP (v2.25) cleaned up — light, calm, industrial B2B.

## Where things live

| What | Where |
|---|---|
| Tokens and every shared style | `app/globals.css` (single stylesheet; sections 1–9 listed in its header) |
| App shell for all roles (sidebar, topbar, content) | `app/(panel)/layout.tsx` — menu items come from `lib/roles` + permissions |
| Sidebar links / collapse / "Hareketler" slot | `app/(panel)/NavLinks.tsx`, `components/Sidebar.tsx` — a link with a query (`/siparisler?panel=cizim`) is active only on exactly that page with those parameters |
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
  sidebar. Drawing team (3.53.0): customer files → technical drawing files (`#cizim-dosyalari`: start + upload +
  versions with files) → drawing approval and revision (`#cizim`: state line, DWG/DXF decision box, approval /
  revision history, withdraw) → notes → order information; no stepper or action cards — status is shown as badges
  in the page head; no offer / finance / crates.
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

## Loadings and crates (3.29.0; firm table 3.57.0)

- Page header: title left, `.page-tools` right (day picker + "Nakliye Listesi" PDF + "Yükleme Özeti Excel").
- Calendar: `.cal` / `.cal-day` (`.has` = day with loads, `.sel` = selected, `.other` = outside the month). Top-right
  `.cal-badges`: two equal circles `.cal-count` (orders — tokens `--cal-total-bg / -border / -text`, pastel yellow, dark
  number) and `.cal-guests` (guest loads — `--cal-guest-*`, pastel pink / red, dark red number; not rendered when 0 or for
  customers); `.long` shrinks 3-digit numbers. On narrow screens the circles sit absolutely in the cell's top-right corner
  (17 px, 15 px under 360 px). Never style these with literal colours — change the tokens.
- Day detail (internal roles): `.table-wrap.load-wrap > table.load-table.firm-table`, ONE `tbody.firm[data-firm]` per
  firm (`FirmRows.tsx`): `tr.firm-row` (`.firm-toggle` button with the name + `.firm-caret`, `.firm-badges`, numeric
  cells `td[data-col]`, `td.actions.firm-actions` = Sandık / PDF / Excel / Özet) → hidden `tr.firm-orders` (nested
  `table.sub-table.firm-orders-table`, `tr[data-order]`, `tfoot` total) → hidden `tr.firm-crates` (`.firm-crates-box`:
  `.guest-note` warnings, crate editor, `.guest-box` for hosted guest loads). The table's own total is `> tfoot`. Customers
  keep the order-based `table.load-table` with their own crates (`tr.crate-row` + `<details>`).
- Firm summary page (`/yuklemeler/ozet`): `.stats.summary-stats`, `#ozet-tutarlar` (Admin only), `#ozet-siparisler`,
  `#ozet-fiziksel` (`[data-crates]`, `[data-away]`, `[data-in]`).
- Crate editor (`CrateEditor.tsx`): `.crate-editor` card → `.section-head` → `table.crate-table`
  (`.c-no / .c-dim / .c-kg / .c-note / .c-del` — no inline widths) → `.tool-bar`. Read-only roles get
  `table.crate-table.readonly`. A crate carrying another firm's order shows `tr.crate-guests[data-crate]` under its row
  (number read-only, delete disabled); a firm whose orders that day are all guests gets `p.crate-locked` and a disabled
  "+ Sandık ekle".
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
- Drawer screen split (3.53.0): the same version renderer serves both cards (`FactoryVersion part="files" | "review"`);
  the "güncel" label appears once (files part). Customer DWG/DXF decision records are `.drawing-version.customer-record`
  (grey box: version, decision badge, the customer's files as links, the faulty note). The decision box is `.dwg-panel`
  (amber "your turn" box, `<h3 class="sub-title">`); its buttons sit in `.dwg-actions` (`DwgDecision`): "Üretime Hazır" =
  `ConfirmButton success`, "Çizimi Güncelle" = `ConfirmButton outline`, "Çizim Hatalı" = a `<details class="dwg-faulty">`
  whose summary is `.btn.btn-danger` and whose form holds the required note + `ConfirmButton danger outline`.
- Red marking: an order whose customer asked for a revision is `tr.row-alert` in every list (red row + red left edge; the
  "Revizyon istendi" badge carries the meaning) and the drawer's order page starts with `.alert.alert-error#revizyon`;
  the customer's faulty-drawing notice is `.alert.alert-error#cizim-hatali`, its answers live in the turn card `#duzeltme`.
- `ConfirmButton outline` = secondary button (`.btn`), `outline danger` = `.btn.btn-danger` (critical but reversible).
- Annotation colours are fixed (red / amber) so they stay readable on any drawing — the only place where
  colours are not tokens.

## Customer New Order forms (3.32.0)

- Page head: back link, title, one-line intro, then `.type-row` (order-type badge + "change type" link).
- Glass order (`NewOrderForm.tsx`), old TAKİP order: order info (`.alert.alert-info.ship-note` with the
  estimated loading date, then name + number in `.grid-2`) → files → glass → note → `.submit-bar`.
- Files: `label.dropzone` (the real `<input type="file" class="dropzone-input">` is visually hidden but is
  still the field the form submits) with `.dropzone-icon`; chosen files in `.upload-list` as `.file-row`s
  (ext chip, name, size, remove). Never build a second upload path — only the selection UI is custom.
- Glass: exactly one glass — `.glass-pick` (one select with a visible label; no quantity field — decision 160). No "add glass" control
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
  `.badge-ok`); `.guest-box` under the customer's crate section holds the relation lines (`.guest-in` / `.guest-out`).
- "Özel durum" (3.48.0): Admin picks the host FIRM on the order page — `form.card.guest-host#ozel-durum` right below
  `#teklif`: a `label.check` checkbox; when ticked, `select#guest-host` (firms only) + primary "Kaydet" + a status
  badge (`.badge-danger` "Sandık seçimi bekliyor" / `.badge-ok` "Sandık 15"). On the loading day, every waiting
  placement is a `.alert.alert-error.guest-waiting` at the top of `#gun`, the order row gets a
  `.badge.badge-danger.guest-badge`, and the host firm's `.guest-box` starts with `.guest-head`
  ("ÖZEL DURUM / MİSAFİR YÜK") followed by one `form.guest-in` per guest order: order · firm, a crate `<select>`
  (first option = waiting) and a plain `.btn` "Kaydet" for `CRATE_EDIT`; without crates a `.badge-danger` note.

## Receivables: document missing in FGO (3.50.0)

- When the last FGO check of a document said "document does not exist" (`absentInFgo`), the receivables page shows one
  `.alert.alert-warn#fgo-absent` under the page head (count + document numbers linking to `#doc-<id>` rows) and, in that
  row's status cell, `form.doc-absent`: a red `.cell-note` ("FGO'da artık yok" / "nu mai există în FGO") and an inline
  danger `ConfirmButton` "TAKİP'ten kaldır" / "Șterge din TAKİP". Healthy rows and rows with any other check error get
  no button (the generic "son kontrol olmadı" note stays). Never add this action to other pages or roles.
- The confirm text must say the record is removed from TAKİP only and that documents existing in FGO cannot be deleted
  by this action. Result messages are fixed texts (`accounting.receivables.remove.*`): `#doc-removed` (ok) /
  `#doc-remove-error`; never print FGO's raw error.

## GKH branding in PDFs and e-mails (3.49.1, logo replaced in 3.49.2)

Rule: all TAKİP-generated HTML e-mails and TAKİP-generated company PDF documents use the official GKH Trading Invest
logo through the shared branding infrastructure (`server/branding`, decisions.md #129, #131). The app screens keep the
"GKH Digital" product logo (`components/BrandLogo.tsx`) — that is a different mark and is not affected.

- Asset: `assets/brand/gkh-trading-invest-logo.png` (landscape, 1596 × 643, transparent background, building mark +
  dark "GKH Trading Invest" lettering). It is the owner's `assets/brand/source/logo-seffaf.png` with only the white
  lettering recoloured dark so it reads on white; use it on WHITE / light backgrounds only (the white-lettering source
  is for dark backgrounds and is not used by any output). Always scaled from its own ratio — give ONE dimension and
  derive the other (`brandLogoSize`); never set both by hand, never crop.
- PDF header (`server/pdf/brand.js`): logo at the top of the first page, inside the page margins, 48–84 pt high
  depending on the document (offer 56, Comanda Depozit 84, transport list 48 at top-right on every page). Text beside
  the logo is positioned from the DRAWN width returned by `drawBrandLogo` (never a fixed offset), with clear space
  around it. Transparency is kept in the PDF (`/SMask`). The transport list prints the official company name
  "GKH Trading Invest SRL" (`BRAND.company`) left of the logo. No other mark in the header.
- E-mail sender (3.50.2): always "GKH Trading Invest SRL <configured address>", set once in the send point
  (`mailSender`); templates never write a sender.
- E-mail (`server/mail/layout.js`): light grey page, one white 600 px card (full width on phones), header row
  (explicit white background) with the logo at 200 px width (`height:auto`), a thin divider, then the template body
  (Arial 14 px). Templates supply body HTML only and keep their own plain-text version. No remote images; the logo is
  an inline PNG attachment. The document is marked light-only (`color-scheme`) because the lettering is dark.

## Note translation (3.49.0)

- Notes keep the existing `.note` box. When a stored translation is shown: `.note-label` ("Özgün mesaj" / "Mesaj original")
  above the original (`.pre.note-text`), then `.note-translation` — secondary (muted text, thin left border) but body
  size — with its own `.note-label` in the translation's language ("Türkçe · otomatik çevrilmiştir" / "Română · tradus
  automat"; never localized to the UI language) and the translated text in `.pre`. No translation → the note looks
  exactly as before (no labels).
- Staff only: `.note-translation.note-state` (meta size) for "pending" and `.note-state.failed` (danger border / text)
  for a failed translation, with a `.btn.btn-link` "Çeviriyi yeniden dene". Customers never see state or error.
  Inspector (3.49.1) sees notes in their original language only: no labels, no translation block, no state, no retry.
- Admin → Entegrasyonlar: `form.card#ceviri` — enable checkbox, one password input for the key (placeholder shows
  "kayıtlı", value never rendered), "Kaydet"; below the card a plain `.btn` "Bağlantıyı dene" with a `.muted.small`
  hint. `.alert-warn` inside the card when the fake provider (test mode) is active.

## Order selection, uninvoiced reminder (3.48.0)

- Proforma preview and the loading "Faturalama" card: one checkbox per eligible order in the order row
  (`tr.sub[data-order]`), bound with `form="…"` to a GET form holding the "Seçimi uygula" `.btn` and a `.muted.small`
  hint under the table. Unselected orders stay as a muted row ("seçilmedi — bu belgeye girmez"); totals, FX and the
  create button always describe the selected orders only. No client state: the selection lives in the URL.
- Muhasebe → Cam Tahsilat: `.card.card-flush#fatura-bekliyor` above the stats — title in `.text-danger` with a
  `.badge-danger` count, intro in `.card-tools`, an `.acc-table` (order · customer, loading date, `.badge-danger`
  "n gündür fatura edilmedi" + `.cell-note` reason, action `.btn`). It disappears when nothing is waiting.
- Admin → Entegrasyonlar: `form.card#muhasebe` — one number input (`min 0`, `max 60`) + primary "Kaydet" + `.hint`.

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
- "Siparişi sil" (`#sil`, `.remove-order`, Admin only — two stages since 3.54.0): a `.btn-danger` opens step 1
  (`[data-remove-step="1"]`: `.remove-target` with the order number, then either the consequences or an `.alert-error`
  `[data-remove-blocked]` with the lock reasons as a `.plain-list`); "Devam et" (`.btn-danger`, only when not blocked)
  opens step 2 (`[data-remove-step="2"]`: the order number typed into `#sil-no`; the `.btn-danger-solid` stays disabled
  until it matches). "Vazgeç" closes the section at every step. Removed orders: `#silinen` card with a
  `details.removed-list` on the orders page (restore = `ConfirmButton primary`).

### Admin panel (3.54.0)

- Order info card: Admin sees neither "İstenen camlar" nor the "Sandıklar" card (`#sandik`); crates stay on the loading
  day. No layout change to `.order-info`.
- Crate fee (Admin only): "+ Sandık parası" in the Admin offer editor; the row carries `badge-info` `[data-crate-fee]`
  "Sandık bedeli · satış görmez" (editor and offer view, Admin only); no dimensions, unit fixed "adet", no "+CNC / +Delik".
- Price lock: `.alert-warn#fiyat-kilidi` under the offer view (title, text, reasons as `.plain-list`) instead of the
  "Teklifi güncelle" link. "Güncelle ve müşteriye gönder" asks for confirmation (`window.confirm`, new version number).
- "Hareketler" (Admin): customer price changes are `.timeline` items `li[data-price-change=<version>]` with a nested
  `ul.price-changes` (one line per changed row: old → new) and `.small.muted` total; no dot on the nested lines.

### Compensation price + one-piece operations (3.44.0)

- Compensation form price row: `.chip` radios only — Sales sees two ("Aynı fiyat", "Bedelsiz") and a `.small` line saying
  the price is the Admin's (no amount is rendered for Sales); Admin sees three, with amounts on the chips
  ("Aynı fiyat — 66,96 EUR/m²", "Bedelsiz — 0 EUR/m²", "Başka fiyat (yönetici)") and the existing price input.
- Glass `<select>` options end with the physical configuration ("işlemsiz" / "CNC × 1, Delik × 2"); a legacy row with
  unassigned operations is a disabled option. No new component.
- Decisions card: `badge-info` "Bedelsiz telafi" / "Müşteri fiyatı değiştirildi" only when the decision differs from
  "same price".
- Offer editor: no new control type. "+CNC / +Delik" split the row in place (state only) and show one `.alert-info`
  (`role="status"`); the quantity input of a one-piece row with operations is `readOnly` (with a `title`); "+ aynısı" is
  another `.btn-link` in `.line-actions`; the rule is explained by one `.muted.small` line under the table. A legacy
  violation is listed by the existing problems block and disables "save draft".

### Split rows + billing e-mail (3.45.0)

- Offer editor / offer view: no new element. Rows of a split line show their SHARE of the line's m² and amount (e.g.
  1,33 + 0,34 = 1,67); the footer total is the line's real total. The group key travels in a hidden `l_group` input.
- Admin customer form: one more field in the existing "Fatura bilgileri" `.grid` — `type="email"` input "E-mail
  facturare" with a `.hint` (help text + the fallback address when the firm has one). No new section or page.
- Receivables e-mail cell: the "Email yok" badge carries a `title` telling Admin where to enter the address.

## Financial documents (3.43.0)

- Customer page "Documente financiare" (`/belgeler`): the standard `.page-head` + one `.card.card-flush` with a
  `table.doc-table` (type, number, date, orders, total, currency, payment `Badge`, `.actions` with a `.btn` "Vezi PDF")
  and a `.card-note`. Payment tones: unpaid = danger, partial = warn, paid = ok, replaced / unknown = muted. The row
  reached from a notification (`#doc-<id>`) is highlighted with `tr:target` (primary-soft). No charts, no totals row.
- Admin receivables table: the last column is `td.doc-mail` — e-mail state `Badge` (sent = ok, waiting = muted,
  failed = danger, no e-mail = warn; error / recipient in the `title`) and, below it, a small `.btn-link` "Tekrar
  gönder" (`ConfirmButton`; the confirm text says no FGO document is issued). The FGO check time moved under the
  payment badge as a `.cell-note` so the table still fits a 1440 px screen. No separate e-mail page.

## Customer panel (3.52.0, decisions 160–166)

- Customer home (`/siparisler`): `form.card#tekliflerim` (GET) right under the page head, before the `.stats` row —
  title, intro, `.offer-report-range` (two `type=date` inputs + "Göster" `.btn` + "PDF indir" `.btn-primary` with
  `formAction="/teklifler/pdf"`), errors as `.alert-error`, then `table.offer-report-table` (order link + `v2` badge,
  date, m², amount) with per-currency totals in `tfoot`. No new control types.
- Order page (customer): a drawing waiting for the customer shows `.alert.alert-error#cizim-onay` above the stepper
  (bold title + text + one `.btn-primary` "Aç ve incele"); the customer card's first button is the same link
  (`.btn-primary`), approve stays `.btn-success`, revision becomes a plain `.btn`. In the drawings card the pending
  version's "Aç ve incele" is a `.btn-primary` (other versions keep the small link).
- Revision note: in the viewer's revision card `ol.revision-items > li.revision-item` (`.badge-info` number +
  `textarea[name=item]` + "✕" `.btn-link.danger`), "+ Madde ekle" `.btn-link`. Shown notes: `RevisionNote`
  (`components/RevisionNote.tsx`) renders `ol.revision-list` (legacy free text → `.pre`) and, for internal roles, the
  stored translation in the same `.note-translation` / `.note-label` block as order notes. The marks panel
  (`.viewer-side`) renders only when there are marks (or in an editable viewer — currently unused).
- Profile order: customer stock warning `.alert.alert-warn#stok` (since 3.55.0 a `.plain-list` of the customer's OWN short
  items, `li[data-stock-line]` "needed / available / missing" at order time + a `.small.muted` note); Admin (and Inspector —
  `STOCK_VIEW`) `.card#stok` with `table.profile-table.stock-table` (needed / current / missing — missing in `.text-danger`);
  "Stok yetersiz" is a danger `Badge` in the page head and in the internal order list.

## Profile calculator and stock (3.55.0, decisions 175–178)

- Customer profile form: `ProfileCalculator` is a `.card.calc-card#hesaplayici` right under the order-info card — title, one
  `.muted.small` intro, then ONE horizontal `.calc-bar` (flex, wraps; `.calc-field` label-over-control: system `.calc-system`,
  color, thickness — disabled with "not needed" when the system has no such condition —, metres `.calc-meters` right-aligned,
  then the `.btn-primary` "Hesapla"). Errors: `.alert-error[data-calc-errors]` with a `.plain-list`. Result: `.calc-result`
  (`h3.sub-title` + `table.profile-table.calc-table`: product, need text, quantity `[data-calc-qty]` + unit; a short item shows a
  `.small.text-danger[data-calc-stock]` line) and a `.row` "Forma aktar" (`.btn-primary`) / "Sonucu kapat" (`.btn-link`). Overwrite
  confirmation is inline, never `window.confirm`: `.alert-warn[data-calc-confirm]` (title, text, `.plain-list` "product: old → new",
  `.row` "Evet, üzerine yaz" `.btn-primary` + "Vazgeç" `.btn`). Success `.alert-ok[data-calc-applied]`. On narrow screens every
  field and the button take the full width. Form rows carry `badge-info[data-calc-mark=calc]` "hesaplandı" or
  `badge-warn[data-calc-mark=edited]` "değiştirildi" next to the code.
- Pre-submit stock warning: `.alert-warn#stok-uyari[data-stock-check]` above the submit bar (title, intro,
  `table.profile-table.stock-check-table` needed / available / missing — missing `.text-danger` —, `.row` "Yine de gönder"
  `.btn-primary` + "Vazgeç" `.btn`). The send button label switches to "Stok kontrol ediliyor…" while checking.
- Admin calculator page `/admin/profil-katalogu/hesaplama`: `.page-head` (back link, title, intro, `.muted.small` rule) → `.grid-2`
  (`.card#kalinlik` thickness table + one-line `form.acc-form`; `form.card#yeni-sistem`) → `.card.card-flush#sistemler` (code,
  name, rows, state `Badge` "Hazır" ok / "N eksik" warn, "Aç") → when a system is open: `form.card#sistem` (names, active),
  `.card.card-flush#kalemler` (`table.calc-items`, one `.group-row` per slot, per row an inline `.threshold-form` for the
  consumption and a `ConfirmButton danger` delete), `form.card#satir-ekle` (`.grid-3`: slot with `datalist`, product incl.
  "— not needed", consumption, color, thickness), `.card#eksikler` (`.alert-ok[data-calc-ready]` or a `.plain-list` of
  `li[data-problem]`). Catalogue: two more fields in the product form `.grid-3` (pack content, measure) and a "Paket içeriği"
  column (`[data-pack]`, "137 m / kutu").
- Stock page `/admin/stok`: Inspector gets the same table without any form (`.alert-info[data-stock-readonly]`, no Excel).
  Columns: code, product, unit, stock (`td.num` first), Rezerve (`[data-reserved]`), threshold (`[data-threshold]` — Admin: an
  inline `form.threshold-form` with a `.qty-input` and "Eşiği kaydet"), status (`[data-status]`: danger `Badge` "Kritik",
  `.small.text-danger` "rezerveye N eksik"). A critical row is `tr.row-alert`. "Önemli kararlar" shows a `STOCK_CRITICAL` row
  with the product code linking to `/admin/stok#s-<id>` and `li[data-critical]`.

## Suppliers, purchasing and supplier accounts (3.56.0, decisions 179–185)

- Menu: the Admin's "Entegrasyonlar" link is now **"Ayarlar"** (same URL); a new sidebar section **"Satın Alma"** with
  "Tedarikçi Siparişleri" (`/siparisler/tedarik`) and "Tedarikçi Hesapları" (`/admin/muhasebe/tedarikciler`). Only Admin.
- Ayarlar: one page head (`h1` "Ayarlar") + `.tabs[data-settings-tabs]` (`SettingsTabs`: Entegrasyonlar | Tedarikçiler;
  `a.active` + `aria-current`). Tedarikçiler: `form.card#tedarikci` (`.grid-3`: name, contact, e-mail with `.hint`, phone,
  currency, address; "Etkin" checkbox only when editing) → `.card.card-flush` table (`tr[data-supplier]`, e-mail cell
  `[data-email]` or warn `Badge` "E-posta yok", counts, ok / muted status badge, "Düzenle" + inline "Pasif yap / Etkinleştir").
  Missing e-mails: `.alert-warn#eposta-eksik`.
- Supplier order list: `.page-head.row` (critical-stock button + primary "Yeni sipariş"), `.tabs` (Açık / Teslim alınan /
  İptal / Tümü), table rows `tr[data-supplier-order]` (status via the shared `components/SupplierStatus.tsx` → `Badge`:
  muted Taslak, info Gönderim bekliyor, ok Gönderildi, danger Gönderilemedi + `tr.row-alert`, purple Teslim alındı, muted
  İptal), total with a warn `Badge` "Fiyat eksik", ETA cell `[data-eta]` with warn "Yaklaşıyor" / danger "Tarih geçti".
- New order (`/siparisler/tedarik/yeni`): empty draft (`form.card#yeni`: supplier select), one product from a stock row
  (`?urun=`), or the critical list (`?kritik=1`: one `form.card.card-flush[data-critical-group]` per defined supplier, rows
  `tr[data-create-row]` with checkbox, stock / Rezerve / threshold / expected, purchase price or warn "Fiyat yok", qty and
  color inputs). Quantities are never pre-filled.
- Order page: status `.alert` (`[data-status-info]`: info / ok / error), `.card#bilgiler` (`dl.order-info` rows; e-mail or a
  danger `Badge` + link to Ayarlar), the draft editor `SupplierOrderEditor` (`.card#taslak`: number / date in `.grid-3`,
  `table.supplier-lines` with `tr[data-line]` — product select with "Bu tedarikçinin ürünleri / Diğer ürünler" optgroups,
  description, color, qty, unit, price (`.price-input`; warn badge `[data-no-price]`, "Kayıtlı fiyatı kullan" link),
  `[data-line-total]`; `tfoot` `[data-grand-total]`; `.alert-warn[data-missing-price]`; "Taslağı kaydet" + `[data-unsaved]`;
  `.approve-box` with the primary "Siparişi onayla / gönder" — a disabled plain button while unsaved / no e-mail / no lines,
  otherwise a `ConfirmButton`). Invalid inputs use `aria-invalid` (red border, shared rule). Attachments `.card#ekler` reuse
  `.file-row` (extension, name, scan `Badge`, size, "İndir", "Çıkar") + a one-line upload form. Sent revision
  `.card.card-flush#gonderilen` (read-only table, `tr[data-final-line]`). `.card#eta` (date + "Kaydet", "Tarihi sil" link),
  `.card#islemler` (Tekrar gönder, Yeni revizyon başlat, Revizyon taslağını bırak, Teslim alındı, Taslağı sil; cancel form
  `#iptal` with a required reason), `.card.card-flush#gonderimler` (job rows `tr[data-email-job]`), `.card.card-flush#gecmis`
  (`.timeline`).
- Supplier accounts: overview table (`tr[data-account]`, one `div[data-balance]` per currency — never summed); detail:
  `.card#bakiye` (`table.acc-table`, `tr[data-balance]`, negative balance `.text-danger`, `.alert-warn[data-missing-price]`),
  orders `.card.card-flush#siparisler` (cancelled rows dimmed, "borca girmez"), payment form `form.card#odeme` (hidden
  one-time `requestKey`), payments `.card.card-flush#odemeler` (`tr[data-payment]`; voided amount struck through + reason;
  inline reason input + `ConfirmButton` "Ödemeyi iptal et").
- Profile Stock (Admin only): header button "Kritik stok için sipariş hazırla", columns "Beklenen" (`[data-expected]`, other
  units as `.small.muted` lines) and a "Sipariş hazırla" link (`[data-prepare]`). Profile Catalogue product form: section
  `.purchase-box#alis` (`h3.sub-title` + `.grid-3`: supplier, purchase price, currency, order unit) and an "Alış" column
  (`[data-purchase]`). "Önemli kararlar": `STOCK_CRITICAL` rows get "Tedarikçi siparişi hazırla".

## Loadings firm table and exports (3.57.0, decisions 186–191)

- Loading day: see "Loadings and crates" — one `tbody.firm` per firm; actions are buttons / links in `td.firm-actions`
  (`[data-action=crates|pdf|xlsx|summary]`); the "Sandık" button is a toggle (`.btn.active` while open, `aria-expanded`).
- Calendar circles: `.cal-count` / `.cal-guests` (tokens only; equal size; number centred; hidden guest circle at 0).
- Excel: one writer, `server/files/xlsx-report.js` — logo top-right (aspect ratio kept), title + subtitle row, block
  titles, header row (blue-grey fill, bold, wrap), totals row (grey fill, bold), AutoFilter on the first table, frozen
  header, print area + repeated header + fit to width, footer "company · page / total". Column types decide number
  formats (`int`, `dec2`, `dec3`, `kg`, `m2`, `mm`, `money` with `unit`); `wrap` for long text; `span` merges cells so a
  second table lines up with the first table's column widths. Never set cell styles by hand in a route.
- PDF: header logo (`drawBrandLogo`, text placed from the returned width) + footer `finishPages` on every page; tables
  repeat their header after a page break; numbers right-aligned, text left-aligned with a small gap after a number column.
- File names: always `exportName` / `exportFileName` (panel language, safe ASCII) — never a literal `filename=` in a route.

## Work calendars, delivery date, photos and report (3.58.0, decisions 192–197)

- Ayarlar → **Çalışma Takvimleri** (`SettingsTabs` third tab, `/admin/entegrasyonlar/takvimler`): `.card#takvim[data-calendar]`
  with `.cal-nav` (calendar buttons `[data-calendar-tab]` — the active one `.btn-primary` + `aria-current`; month prev / next /
  current links), usage and time-zone line, data line `[data-holiday-data]` and `.alert-warn[data-holiday-gap]` for a year
  without data; month grid `.cal-month` (7 columns `minmax(0, 1fr)`, Monday first; `.cal-head`, `.cal-blank`, `.cal-cell`
  `[data-day][data-open][data-reason]` with `.cal-num` + `.cal-tag`; state classes `closed`, `holiday`, `half`, `manual-open`,
  `manual-closed`, `today` — tokens only); `.cal-legend`. Mark a day: `form.card#isaretle` (`.cal-form`: day, mode select,
  note). Manual decisions `.card#elle` (`tr[data-override]`, "Kaldır" via `ConfirmButton`); upcoming holidays `.card#tatiller`
  (`li[data-holiday]`). Below 560 px the cell tags are hidden (numbers only) — no horizontal scroll.
- Profile order page: the delivery card `.card#teslim` ("Teslimat") replaces the old pickup card — `table.kv` with the
  estimated day `b[data-delivery-date]`, the phase `Badge` (muted Depoda hazırlanıyor / info Teslimata hazır / ok Teslim
  edildi), phone and plate; before a date exists `p[data-delivery-estimate]`; the estimate text `p.small.muted[data-delivery-note]`;
  customer stock note `.alert-warn[data-delivery-stock]`; Admin data gap `.alert-warn[data-calendar-gap]`; the edit form stays a
  `details` ("Bilgileri değiştir", `#up-date` with the Admin hint). Customer in the warehouse stage: `.alert-info` (locked).
- Delivery documents `.card#teslimat`: photo grid `.photo-grid[data-delivery-photos]` (auto-fill 132 px tiles,
  `figure.photo-tile[data-photo]` → link + `img` 112 px `object-fit: cover`, `figcaption` time · source · "taranıyor");
  empty `p[data-no-photos]`. Upload (Admin, depot page): the shared `DeliveryPhotoUpload` — file input + "Yükle", hint, then
  `.photo-progress` (`aria-live`, "n / N", `progress`, `ul.photo-status` rows `li[data-upload-state]` with a state `Badge` and
  a red error line). Report: `h3#rapor`, `ul.report-list[data-delivery-reports]` (`li[data-report]`: link "Rapor #n · date",
  ok `Badge` "Güncel rapor" on the newest; staff see who created it), empty `p[data-no-reports]`; Admin form (note `#dr-note` +
  primary "Teslimat raporu oluştur"). The history entry "Teslimat raporu" links to `#teslimat`.
- Depot link page: two `section.depot-section` blocks — `#fotograflar` (upload + `ul[data-depot-photos]`) and `#rapor` (note
  `#dep-note` + "Teslimat raporu oluştur" + `ul[data-depot-reports]`), under the existing confirm form.
- Supplier order `#eta`: calendar warning `.alert[data-eta-calendar]` (warn for `closed`, info for `half` / `noData`).
- Delivery report PDF: shared brand header + footer, `kv` info rows, note, items table with repeated header, photo list with
  links, then one embedded photo per box (507 × 292, EXIF orientation applied; a photo that cannot be embedded is marked).

## Messages, settings and live search (3.59.0, decisions 198–202)

- Unread message counter: one look everywhere — `.msg-count` (red pill, white bold number, 1…99 / "99+"; `components/MsgCount.tsx`).
  Order list row: after the order number, wrapped in `a.msg-count-link` to `#notlar` (`[data-unread]`). Sidebar / mobile nav: inside
  the "Siparişler" link (`[data-nav-unread]`, `aria-hidden`; the link's `title` carries "n okunmamış mesaj" so its accessible name
  stays "Siparişler"). Order page: in the "Notlar" heading (`[data-unread-notes]`); new notes get `.note.note-new` (red left border)
  and a danger `Badge` "Yeni" in the meta line (`[data-new="1"]`). Never a second counter style.
- Settings `/ayarlar` (all roles): customer title "Ayarlar", staff "Hesap ayarları" (sidebar section "Hesabım"); language select
  Otomatik / Türkçe / Română; e-mail checkbox only for the customer; sound for everyone.
- Live search (`components/LiveSearch.tsx`): replaces the plain search input inside the existing `.toolbar` / card-head forms; the
  "Ara" button stays. `.live-search` wrapper (input + `.live-search-state` "Aranıyor…", `aria-live`); full width below 640 px.
  Result line under the toolbar: `p.search-result[data-search-result]` ("Aramayla eşleşen: n" / "Aramanızla eşleşen sipariş yok.").

## Left for the page-level phase

Done so far: tokens and shared classes (3.26.0); shell, dashboards and standard list pages (3.27.0);
order detail and offer editor (3.28.0); loadings and crates (3.29.0); drawing section and viewer (3.31.0);
customer new-order forms (3.32.0); accounting (3.33.0). Still to do, page by page:

- Profile order detail page:
  layout and hierarchy (the old TAKİP arrangement) — not redesigned yet; they only inherit the shared styles.
- ~250 inline `style={{…}}` uses in `.tsx` (mostly margins and widths) — move to classes when each page is touched.
- Old-system features that do not exist here and were not faked:
  per-section search/sort/group controls on the panels, "act on behalf of customer" bar (Phase 9),
  offer header fields (company / project / delivery date inside the editor), offer lock ("Kilitle").
