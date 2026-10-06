# GKH TAKIP — Claude Code Project Instructions

## Source of truth
The detailed product specification is `GKH_TAKIP_REBUILD_SPEC.docx`.
Treat that document and these rules as the source of truth for rebuilding the GKH TAKIP order and production portal.

Do not invent business rules when the specification is ambiguous. Document the ambiguity and ask before implementing behavior that changes the workflow.

## Working method
Work phase by phase. Do not try to rebuild the whole application in one pass.

For every phase:
1. Inspect the existing repository, schema, migrations, routes and tests first.
2. Write a short implementation plan.
3. Implement database/domain logic before UI.
4. Add automated tests for the business rules.
5. Run tests, lint/type checks and relevant build checks.
6. Report changed files, migrations, tests, manual verification steps and remaining risks.
7. Do not start the next phase until the current phase is stable.

Start with **Phase 0 only** unless explicitly instructed otherwise.

## Non-negotiable business rules

### Roles
The system has five primary roles:
- Admin / Yönetici
- Customer / Müşteri
- Sales / Satışçı
- Drawing / Çizimci
- Inspector / Denetimci

Authorization must be enforced server-side. Hiding a button is never sufficient authorization.

### Customer identity privacy
Sales and Drawing users may see only the first three characters of the customer's company name followed by masking.

Examples:
- `GLASSANDMORE` → `GLA***********`
- `ALEGRAD` → `ALE****`
- `FOL Expert` → `FOL*******`

This masking MUST happen on the server/API layer. Never send the full company name to Sales or Drawing clients and mask it only in the browser.

Admin sees the full company name.
Customer sees its own full company name.
Inspector follows the explicit permissions defined in the master specification.

### Order numbering
Glass orders preserve the customer/company three-letter prefix followed by the company's sequence number.

Example:
`GLASSANDMORE` → company code `GLA` → order `GLA68`

Generate sequence numbers transactionally and enforce uniqueness in the database.

Do not invent the meaning of suffixes such as `GLA64-1`. Keep customer order/reference numbers separate unless a confirmed business rule says otherwise.

### Order types
Order types must be extensible.

Initial types:
- `GLASS_ORDER`
- `PROFILE_ORDER`

The customer New Order screen first asks which order type to create.

Future order types must be addable without redesigning authentication, audit logging, notifications, order history or shared order infrastructure.

## Glass Order workflow
Preserve the existing glass-order behavior.

High-level flow:

```text
CUSTOMER SUBMITS
    ↓
SALES REVIEW
    ├─ drawing required → DRAWING TEAM
    └─ no drawing required → quote path
    ↓
DRAWING / REVISION / APPROVAL LOOP when required
    ↓
SALES PREPARES QUOTE
    ↓
WAITING FOR ADMIN PRICING
    ↓
ADMIN PRICES / REVIEWS
    ↓
ADMIN SENDS TO CUSTOMER
    ↓
CUSTOMER-VISIBLE OFFER / APPROVAL
    ↓
PRODUCTION / LOADING / COMPLETION / ARCHIVE
```

### Critical quote rule
When Sales prepares and sends a quote, it does **NOT** go directly to the customer.

It must go to the Admin pricing/review queue.

Only after Admin prices/reviews the quote and presses **Send to Customer** may the offer become visible in the customer's panel.

Never bypass this rule.

## Profile Order workflow
Profile orders are a separate workflow.

```text
CUSTOMER SELECTS PROFILE ORDER
    ↓
CUSTOMER ENTERS PRODUCT QUANTITIES
    ↓
CUSTOMER SUBMITS
    ↓
WAITING_ADMIN_PRICING
    ↓
ADMIN REVIEWS
    ↓
ADMIN ENTERS PRICES
    ↓
ADMIN SENDS TO CUSTOMER
    ↓
CUSTOMER SEES PRICED PROFILE OFFER
```

Profile orders:
- bypass Sales completely;
- bypass Drawing completely;
- must not appear in Sales queues;
- must not appear in Drawing queues;
- initially go only to Admin for pricing.

## Profile Product Catalogue
Do not hard-code profile products into the customer form.

Create an Admin-managed catalogue with at least:
- category
- stable product code
- product name
- product image
- unit
- display order
- active/inactive status
- optional metadata for future expansion

Initial categories from the supplied source:
- GARNITURI
- PLASTICE
- PROFILE ALUMINIU
- ACCESORII

Initial units include:
- CUTII
- PUNGI
- BARA
- BUCATI

The customer Profile Order page should show the product visual, name/code, unit and quantity input.

Only rows with quantity > 0 should become order items.

Historical profile offers must store a priced snapshot. Later changes to product names, images or price tables must not alter an already issued historical offer.

## Drawings and revisions
Drawing files and revisions are versioned.

Never overwrite an earlier drawing version.

Store:
- drawing
- drawing version
- files
- creator
- timestamps
- status
- approval/revision events
- customer-visible/internal notes

Revision and approval history must remain auditable.

## Notes
Do not implement notes as one mutable text blob.

At minimum support:
- `CUSTOMER_VISIBLE`
- `INTERNAL`

Internal notes must never be exposed to the customer.

## Workflow transitions
Centralize state transitions in a domain service. Do not scatter direct status mutations across controllers or UI components.

Conceptual pattern:

```text
transitionOrder(orderId, action, actor, payload)
  1. Load order and actor permissions.
  2. Verify action is valid for current state and order type.
  3. Validate required data/files/quote/drawing.
  4. Execute in a database transaction.
  5. Update state.
  6. Append status history.
  7. Append audit log.
  8. Enqueue notifications.
  9. Return a role-sanitized representation.
```

Every important state change must create history and audit records.

## Audit
Audit logs are append-only.

Audit at least:
- login/security events
- workflow transitions
- drawing approvals/revisions
- quote sends/withdrawals
- pricing actions
- file access where required
- admin configuration changes
- customer impersonation / acting on behalf of customer

Do not provide normal edit/delete controls for audit records.

## Files
All file access must be authorized.

Store metadata such as:
- original filename
- MIME type
- size
- checksum
- uploader
- related order/entity
- visibility
- storage key
- timestamp

Never trust file extensions alone.
Do not expose private storage paths.
Do not place sensitive uploads in a publicly accessible directory.

## SLA
SLA and escalation are domain behavior, not decorative UI.

Store SLA deadlines explicitly.
Display remaining/overdue time according to role.
Keep historical SLA behavior reproducible even if Admin later changes SLA configuration.

## Notifications
Use event-driven notifications with an outbox/queue and retry handling.

Do not perform external e-mail delivery inside the critical order database transaction.

Customer notification preferences must be respected.

## UI compatibility
Preserve the recognizable existing GKH TAKIP design language:
- left sidebar
- compact identity/header area
- neutral background
- white cards
- thin borders
- blue primary actions
- status pills
- compact operational tables
- green/red SLA indicators
- horizontal workflow progress

Improve responsiveness and accessibility without changing business semantics.

## Security requirements
- Server-side authentication/session handling.
- Server-side RBAC and resource-level authorization.
- Server-side customer-name masking.
- CSRF protection where relevant.
- Rate limiting for login and sensitive actions.
- Validate quantities, dimensions and prices server-side.
- Never expose SMTP/API/integration secrets to clients.
- Use safe password reset with expiring one-time tokens.
- Audit privileged impersonation.
- Use locking/version checks where concurrent quote/drawing edits can occur.

## Data model direction
Expected domain entities include:

`users`, `roles`, `permissions`, `user_roles`, `companies`, `company_users`,
`order_types`, `orders`, `order_status_history`, `order_assignments`,
`order_files`, `order_notes`, `glass_catalog_items`, `glass_order_items`,
`profile_categories`, `profile_products`, `profile_order_items`,
`drawings`, `drawing_versions`, `drawing_files`, `drawing_approvals`,
`drawing_revision_requests`, `quotes`, `quote_versions`, `quote_items`,
`price_tables`, `price_table_items`, `loading_batches`, `crates`,
`notifications`, `notification_preferences`, `notification_outbox`,
`sla_policies`, `approval_policies`, `system_settings`,
`integration_settings`, `audit_logs`.

Use proper foreign keys and constraints.
Use versioned/immutable records for commercial and approval history.
Use soft disabling/deletion for configurable catalogue data where appropriate.

## Development phases

### Phase 0 — Repository & architecture
Project skeleton, environment handling, database/migration strategy, tests, linting, seed framework and architecture decisions.

### Phase 1 — Authentication / RBAC / Companies
Login, users, companies, roles, permissions, server-side company masking and Admin management.

### Phase 2 — Order core
Order types, numbering, orders, files, notes, status history, audit service and customer order list/detail.

### Phase 3 — Glass submission
Glass New Order form, glass catalogue, uploads, Sales review and queues.

### Phase 4 — Drawing workflow
Assignments, versions, approvals, revision loops, notes and SLA.

### Phase 5 — Glass quote / Admin pricing
Sales quote preparation, Admin pricing queue and final Admin Send to Customer.

### Phase 6 — Profile Order
Order selector, Admin-managed profile catalogue, image/quantity order form, Admin-only pricing and customer offer.

### Phase 7 — Loading / logistics
Calendar, loading batches, calculations, crates, weights and exports.

### Phase 8 — Notifications / integrations
SMTP, notification preferences/outbox, WhatsApp/webhooks, translation, viewers and ERP hook.

### Phase 9 — Reports / Admin hardening
Reports, policies, SLA configuration, moderation and audit UI.

### Phase 10 — Regression / deployment readiness
Five-role E2E tests, security tests, demo seeds, backup/restore and deployment documentation.

## Required acceptance rules
Before calling the rebuild complete, verify at minimum:

- Customer can choose Glass Order or Profile Order.
- Glass workflow matches the observed process.
- Profile catalogue is Admin-managed and customer quantities are persisted correctly.
- Profile orders never enter Sales or Drawing queues.
- Sales cannot directly send a glass offer to a customer.
- Admin can price and send the final offer.
- Sales and Drawing APIs never expose full customer company names.
- Drawing revisions preserve previous versions.
- Internal notes never reach customers.
- Workflow transitions create status history and audit entries.
- Company-scoped order numbers remain unique under concurrent creation.
- Notification preferences are respected.
- Historical quotes are immutable snapshots.
- Unauthorized users cannot access another customer's private files.
- Loading totals are reproducible from stored data.

## Ambiguities
Keep these configurable or stop for confirmation:
- meaning/generation of suffixes such as `GLA64-1`;
- final Profile Order number format;
- exact Profile Order statuses after customer approval;
- VAT/tax defaults;
- exact Inspector write permissions;
- complete notification event wording;
- exact crate/gross-weight formulas.

## First instruction
If beginning a fresh rebuild, inspect the repository and execute **Phase 0 only**.

Do not begin Phase 1 or build business screens until Phase 0 architecture, environment, migrations, tests and project structure are stable.

---

## Confirmed project decisions (take precedence over the generic text above)
Decided by the product owner on 2026-09-29. Details and rationale: `docs/decisions.md` and `docs/adr/`.

1. **Drawing and quote run in parallel.** After Sales review, the drawing track (when required) and the quote track proceed independently; the quote does not wait for drawing approval.
2. **Customer does not approve the offer.** The order moves to production automatically when (drawing approved OR drawing not required) AND the Admin has sent the offer to the customer. "CUSTOMER-VISIBLE OFFER / APPROVAL" above means "visible", not "customer approval step".
3. **Sales cannot reject/cancel an order.** Only Admin can cancel.
4. **Two-tier pricing.** Sales enters its own prices (*sales price / sales amount*). Admin creates an *admin copy* as a new quote version and enters customer prices (*offer price / offer amount*). The customer sees only Admin prices. Admin prices are visible to Admin only (and to the customer after Send to Customer). Admin screens (quote, loading) show both columns side by side.
5. **Order number = company code + the customer's order number** (`GLA68`). The customer's number is mandatory, pre-filled with the company's next sequential number, and the customer may change it on the New Order form (fixed after creation). Company codes are unique, so order numbers never collide across companies; within a company the DB enforces uniqueness. If the customer kept the suggested number and a concurrent order took it, the next free number is assigned automatically (`server/orders/create.js`, per-company advisory lock).
6. **Routes stay shared** (`/siparisler`, `/teklifler`, `/yuklemeler`, `/admin/...`); the role decides what the page shows. No `/customer`, `/sales` route prefixes.
7. **Masking is fixed length:** first 3 characters + 10 `*` (e.g. `GLA**********`), applied server-side. This intentionally hides the name length.
8. **Inspector is read-only** in the first release (no write actions).
9. **UI languages: Romanian and Turkish** (no English UI). Login language follows the IP country (TR → tr, RO/MD → ro, otherwise Accept-Language, fallback ro); the user can always switch.
10. **Antivirus for uploads.** Every uploaded file (customer or staff) is scanned; the scanner (ClamAV) is configured on the Admin → Integrations page. See `docs/adr/0010-antivirus.md`.
11. **Inspector** sees all glass orders with full company names, internal notes and internal files, and only offers already sent to the customer (at the customer-visible price). No drafts, no admin-copy prices, no write actions.
12. **Passwords:** new passwords need at least 10 characters (#40; the old "6 characters, one letter + one digit" rule is retired, existing hashes stay valid). Login and code entry are throttled: 5 failures per e-mail+IP, 20 per e-mail, 30 per IP within 15 minutes.
13. **Company code is exactly 3 letters A–Z** everywhere (DB CHECK constraint). Existing longer/shorter codes were migrated and their order numbers renamed. A company's code cannot change once it has orders.
14. **"Act on behalf of customer"** is postponed to Phase 9.
15. **Allowed upload types** (customer and drawing team): PDF, DWG, DXF, STEP/STP, IGS/IGES, XLS/XLSX, DOC/DOCX, ZIP, JPG/JPEG, PNG; max 100 MB per file. The content must match the extension (`server/files/signature.js`).
16. **Antivirus unavailable → accept, mark "not scanned" (PENDING), scan later** (worker). PENDING files are downloadable with a warning badge; INFECTED files are quarantined and never served. Admin can switch the policy to "reject" on Admin → Integrations.
17. **Glass catalogue is bilingual** (TR + RO name and colour; EN kept in Excel only). Everyone sees glass names in their selected UI language. Glass is identified by TR name + TR colour; weight is kg/m², mandatory, used for loading only (never shown in offers). Inactive glass appears in no list. Order items store a snapshot (both names + weight). Admin imports/exports the catalogue as Excel in the product owner's column layout (`server/catalog/glass.js`, `server/files/xlsx.js`). decisions.md #20–23.
18. **Draft orders** (`OrderDraft`): customer-only, firm-scoped, no number/SLA/history, never in any queue; submitting turns it into an order in one transaction (files move, draft deleted). No "request info from customer" state. decisions.md #24–25.
19. **Price tables (Phase 3b):** admin price tables per glass (+ fixed hole/CNC prices), Excel import, one table per salesperson (else default). Sales quote lines are pre-filled; sales may override, which raises an admin "Important decisions" warning. decisions.md #26.
20. **Crates are entered on the Loadings tab** per loading day + customer (Sales or Admin, `CRATE_EDIT`): crate no (unique per day across customers), L/W/H mm, net/gross kg, note, which orders it carries (`Crate` + `CrateOrder`, `server/loading/crates.js`). Entered crates override that customer's estimate for the day. No crate entry on the order page. When an order's loading day changes, its crates move with it (`moveOrderCrates`; shared crates stay, numbers shift if taken). decisions.md #27.

21. **Drawing workflow (Phase 4):** drawer uploads files to a draft version (`TASLAK`, invisible to customer; several files per version in `DrawingFile`), then "Send to customer" with a confirm dialog (`send_drawing`); every file must be antivirus-CLEAN to send. Sent versions are immutable; drawer may withdraw a sent version with a reason before the customer decides (`GERI_CEKILDI`). Single active drawer → auto-assigned on "send to drawing". SLA overdue = red badge + top of queues only. In-app viewer (`siparisler/[id]/cizim/[drawingId]`, pdf.js): drawer "Kontrol Et" before sending, customer review; customer revision requests carry a mandatory note plus optional on-drawing marks (`DrawingRevision.annotations`, validated by `server/orders/annotations.js`). decisions.md #28–31, #77.
    **Phase 5B (decisions.md #84) refines this:** approval is per version and final ("Bu çizimi onayla", also in the viewer). A version can be sent only if it holds at least one CLEAN customer-viewable file (PDF/JPG/PNG; `isViewable`) — DWG/DXF/STEP stay as attachments. Sending happens **only on the viewer page** ("Kontrol Et" → "Müşteriye gönder"): the page issues a signed review proof (`server/orders/review.js`, bound to draft + user + file list, 2 h) and `send_drawing` rejects a request without a valid one (`DRAWING_NOT_CHECKED`) — never add a send button elsewhere without the proof. Approve and revision need the same right: a customer user without `canApprove` can do neither. Revision/approval e-mails go to the assigned drafter + the relevant salesperson (never Admin); the revision e-mail carries the customer's note. The approved-drawings list is shown to Drawing, Sales and Admin (`approvedDrawingList`, loading-day filter). pdf.js fonts/cMaps are served by the app itself (`app/pdfjs/[kind]/[file]`).

22. **Two-tier pricing as implemented (Phase 5, refines #4):** offer lines are shared between Sales and Admin (Admin may change dimensions/qty/lines and Sales sees it); each line has `unitPrice` (sales price, Sales only) and `offerPrice` (customer price, Admin). Admin cannot change sales prices; Sales never receives offer prices (`lib/orders.ts → offerPrices`), customer/inspector receive only offer prices. Customer-specific price tables (`PriceTable.kind = CUSTOMER`, linked per `Customer`) pre-fill offer prices when Sales submits; otherwise empty. Every line needs an offer price before Send to Customer. Event notes never carry amounts. Prices are shown excl. VAT. decisions.md #32–34.

23. **Profile order (Phase 6a):** number `GLAP12` (separate sequence). Flow FIYAT_BEKLIYOR → TEKLIF_GONDERILDI → (customer approves with pickup date, phone, plate) ONAYLANDI → PROFORMA → (payment / "send to warehouse") DEPODA → TESLIM_EDILDI → FATURALANDI. Prices: product list price (EUR) or a linked customer profile price table; Admin may change; sent offer is an immutable snapshot. EUR offers (glass and profile) carry the exchange-rate note of the customer's FX policy (#30); prices excl. VAT. Pickup only on working days, earliest the first working day after payment (moved automatically if payment is late). Warehouse e-mail (PDF Comanda Depozit only, recipients configurable on Admin → Integrations) goes out via the outbox/worker; its one-time depot link lets the warehouse upload the signed receipt and mark delivered. Stock = append-only `StockMovement`; deducted when the order goes to the warehouse, never blocks. Code: `server/profile/*`, `server/pdf/*`. FGO invoicing integration is Phase 6b. decisions.md #35–45.

24. **FGO (Phase 6b):** proforma (series PRF) on customer approval and invoice (series GKH) on delivery are issued automatically through the outbox/worker (`server/profile/fgo-jobs.js`, `server/integrations/fgo.js`) when enabled on Admin → Integrations. Both in **RON**: unit price = EUR offer price × the rate from the customer's exchange-rate policy resolved on the proforma day (see #30); the invoice reuses the proforma rate. Rate/date/source are stored on `ProfileOrder`. Payment is still marked manually (FGO API cannot read bank payments). FGO rejections are not retried (admin alert + "retry in FGO"); manual buttons remain as fallback. The FGO private key is entered only on the Integrations page and stored encrypted (`server/crypto/secret.js`). Customer billing fields: taxId, regCom, country, county, city, address. decisions.md #46–50.

25. **Accounting (admin only, `ACCOUNTING_MANAGE`):** `/admin/muhasebe/{profil,cam,tedarikci}`. FGO documents are recorded in `FgoDocument` when issued; "FGO ile Güncelle" reads total/paid via `factura/getstatus` (`server/accounting/receivables.js`, reuses `server/integrations/fgo.js`). Loading profit per ship day = sale (admin price, `OfferLine.offerPrice`) − cost (sales price = factory price table, `OfferLine.unitPrice`) − transport (`LoadingCost`, manual); see #28. Factory balance = total cost − `FactoryPayment` (not linked to loadings). Currencies are never summed together (`server/accounting/supplier.js`). decisions.md #51–54.

26. **Glass FGO documents (no customer approval, order status untouched):** admin buttons on the glass order page (Finans / FGO): not loaded → Proforma; proforma paid (FGO paid only — #34; the manual "payment received" amount is retired) → Advance invoice (single line "Avans marfă…" = FGO paid − already advanced; also after loading; several advances possible); loaded (ship day + 2 days) → Invoice (glass lines + one negative "Stornare avans" line per advance). **Invoices** list only glass (proformas are detailed: each glass line + separate CNC/hole lines): line name = Romanian glass type only (no size/qty), CNC/hole/other amounts are added to their glass line, same glass types merged by m²; FGO Text = order title only. One proforma and one final invoice per order, advances by sequence (advisory lock, state check, `FgoDocument @@unique([orderId, kind, seq])`, FGO IdExtern). Issued by the worker (`server/glass/billing.js`), recorded in `FgoDocument` (same source as Muhasebe → Cam Tahsilat), rate stored in `GlassBilling`, e-mailed in Romanian to `Customer.email` by TAKİP with the PDF attached (#37). FGO settings include a daily document limit (test safety). Invoice numbers (GKH, glass and profile) are assigned by **FGO** — see #28 (the app never computes "last + 1"); a document deleted in FGO (getstatus "not found", on the admin's "FGO ile Güncelle" or when an invoice is about to be issued) — or by the Admin's per-document "TAKİP'ten kaldır", #45 — is removed and the order reverts (`server/integrations/fgo-deleted.js`; profile: FATURALANDI → TESLIM_EDILDI / PROFORMA → ONAYLANDI via `fgo_doc_deleted`, then "retry in FGO"); a differing FGO number raises an `FGO_NUMBER` alert; proformas numbered by FGO. Invoice glass lines are built from the same VAT-exclusive per-line amounts as the proforma and sent as VAT-inclusive `PretTotal`, so totals match the proforma exactly. decisions.md #55–65.

27. **Customer glass order = exactly one glass type (decisions.md #85).** The customer New Order form has one glass select + quantity (no "+ Cam ekle"); the server rejects zero (`NO_GLASS`) or more than one (`ONE_GLASS`) in `glassOrderItems` and again in `createGlassOrder`. This binds only NEW customer submissions: the multi-item `OrderItem` schema, historical multi-glass orders and the Sales/Admin offer editor ("+ Cam ekle", Excel import) are not restricted. The loading-date note on the form and the stored date both come from `glassLoadingDate` (never add a second formula). The upload area is only a selection UI over the same `files` input + `storeFiles`. Profile orders keep their own workflow (customer approval with pickup date). **Legacy multi-glass drafts (decisions.md #86):** a glass draft saved before this rule with more than one glass (`isLegacyMultiGlass`) is never trimmed silently — the draft page shows all glasses read-only and the customer must explicitly pick and confirm one (`keepDraftGlass`, audited as `DRAFT_GLASS_KEPT`); until then the server refuses to submit or overwrite it (`DRAFT_LEGACY_GLASS`). Viewing never writes.

28. **Accounting / FGO corrections (Phase 7B, decisions.md #87–91):**
    - **Invoice numbering:** FGO generates invoice numbers; `Numar` is not sent. Admin → Integrations "Sonraki fatura numarası" is an optional **one-shot** manual override (`manualInvoiceNumber`): sent exactly once, cleared after the invoice is issued, never auto-incremented. If FGO rejects it, the real FGO error is stored/alerted and no other number is tried. Never reintroduce local "last + 1" numbering. The number saved is always the one FGO returned (`reserveInvoiceNumber`, `afterInvoiceIssued` in `server/integrations/fgo.js`).
    - **Receivables:** documents are all listed, but totals count each order's debt once (`receivables()` in `server/accounting/receivables.js`): a final invoice replaces the proforma; a glass advance invoice replaces that part of the proforma; advance + final never overlap (the final invoice already nets the advance). Never sum `FgoDocument` rows directly for "Kalan".
    - **Cost vs selling price** are two stored values on the offer version sent to the customer: sale = `OfferLine.offerPrice` (Admin), cost = `OfferLine.unitPrice` (sales price captured from the factory price table when the offer was prepared; Admin edits never change it; today's price table is never used). Loading profitability takes both from the lines through `glassTotals` (same rule as invoice and loading Excel; `includeFree` for cost — a customer-free line still has factory cost). Lines **added by Admin** capture the factory table price at that moment (`mergePrices`); if none exists the cost stays 0 and the order is flagged "maliyet eksik" on the supplier page (`noCost`) — never silently treated as 0.
    - **FGO status sync:** the worker runs `syncFgoDocuments` hourly (open documents only, bounded batch, shared lease with the manual button in `IntegrationSetting 'fgo-sync'`). The automatic run only updates total/paid; it never deletes records, reverts orders or raises admin alerts — removal of documents deleted in FGO stays on the manual "FGO ile Güncelle".
    - Confirmed loading and profitability from it: see #29. The customer invoice per confirmed loading is #32 (pre-loading customer proforma: #31); the per-order glass invoice button and its "ship day + 2 days" rule stay only for orders that have their own order-level document chain.

29. **Confirmed loading (Phase 7C, decisions.md #92–94):** a planned loading date is not proof of loading.
    - **Source of truth:** `LoadingConfirmation` (one per ship day — `shipDay @unique`, confirmer, time, note) + `LoadingConfirmationItem` = a copy of each line of the offer version sent to the customer for every eligible order of that day: real commercial owner (`customerId`, `orderId`), `offerLineId` (Restrict), glass names, dimensions, **actually confirmed** `quantity` / `m2`, `unitCost` (= `OfferLine.unitPrice`), `unitSale` (= `OfferLine.offerPrice`), unrounded `costAmount` / `saleAmount`, currency, `status` `LOADED | NOT_LOADED` + separate `notLoadedReason`. Items are shaped like offer lines so the existing engine (`glassTotals` via `itemAsLine` / `lineTotals`) runs on them — never add a second formula. Code: `server/loading/confirmation.js`.
    - **Confirming:** Admin only (`LOADING_CONFIRM`, checked in the action and again in `confirmLoading`). The loading day page shows a preview (customer → order → glass) and "Eksiksiz Yüklendi" with a confirm dialog; all previewed lines are stored `LOADED` at full quantity. Guards: no future day; preview fingerprint (`STALE_PREVIEW` if content changed); one confirmation per day (advisory lock + DB unique); orders without a sent offer or already loaded in another confirmation are skipped and shown. Order status is not changed. Audit `LOADING_CONFIRMED` + an order event per order.
    - **Immutable:** no edit/delete path; a DB trigger rejects UPDATE/DELETE on both tables. Never regenerate a confirmation when an order, offer, price table, catalogue or ship date changes. Corrections / reopening / broken-glass re-planning must be separate audited workflows that add records. Never backfill confirmations from planned dates.
    - **Profitability:** a confirmed day uses its `LOADED` items; unconfirmed days keep the planned-date calculation and are labelled (`mergeConfirmed`). An order is never counted twice; orders planned on a confirmed day but not in the confirmation are not counted ("onay dışı"). Factory payments are never deducted from profit.
    - **Missing cost correction** (`server/accounting/cost-correction.js`, `ACCOUNTING_MANAGE`): Admin may enter only the missing unit cost (`unitPrice` = 0, not free, customer price > 0) of a line in the current sent offer; never overwrites an existing cost; never touches customer price; audited (`OFFER_COST_CORRECTION`); rejected once the order is in a confirmed loading (the snapshot is not rewritten).
    - **Paid proforma without advance invoice + loaded:** the final invoice is blocked while un-advanced FGO payment exists; Admin issues the advance first, also after loading (#34 — `billingState` → `advance` / `advance_required`, re-checked when the job is issued). Do not invent an offset.
    - Physical crates stay decoupled from commercial ownership (#33). Partial loading, not-loaded reasons and replanning the remainder to a later loading: #33.

30. **Customer exchange-rate policy (Phase 7D-1, decisions.md #95–98) — one rule for glass and profile:** `Customer.fxPolicy → resolveExchangeRate() → rate snapshot → FGO document uses the snapshot`.
    - `Customer.fxPolicy` = `BT_UNIT_SELL | BNR | BNR_PLUS_PERCENT` (+ `fxMarkupPercent`, 0–20, max 3 decimals), **mandatory**, default `BT_UNIT_SELL`; set on Admin → Müşteriler (`CUSTOMER_MANAGE`, validated by `parseFxPolicy`). There is no "legacy / not selected" state.
    - **One resolver:** `resolveExchangeRate` in `server/fx/resolve.js` returns `{ policy, currency, baseRate, markupPercent, finalRate, rate, source, sourceDate, resolvedAt, manual }`. Every FGO flow that needs a rate (glass, profile, customer-level documents in 7D-2) must call it — never compute or choose a rate elsewhere.
    - **BNR:** only BNR's own XML (`server/fx/bnr.js`, `curs.bnr.ro`), validated, multiplier-normalised, cached 30 min. Rule: the **latest rate BNR has published** when the rate is resolved (Saturday → Friday's rate); no banking-day calendar; BNR's own date is stored as `sourceDate`. **BNR + %:** exact BigInt arithmetic (`server/fx/decimal.js`), rounded once, half-up, to 4 decimals (5.1000 + 2% = 5.2020).
    - **BT_UNIT_SELL has no automatic source** (the website value "În unitățile BT → Vânzare" has no structured official endpoint and the site rejects server requests): it uses the daily BT rate Admin enters on Integrations (`MANUAL_DAY`, manual). **The BT XML (`exchange.xml`) is never a document rate** — `fxMode` / `fxUrl` / `rateForDay` were removed; the XML reader in `server/fx/bt.js` exists only for the `takip kur` diagnostic. If a required rate is unavailable the document waits; never switch silently to another source.
    - **Snapshot:** written once, with the rate, to `GlassBilling` / `ProfileOrder` (same fields: `fxRate`, `fxDate`, `fxSource`, `fxPolicy`, `fxCurrency`, `fxBaseRate`, `fxMarkupPercent`, `fxSourceDate`, `fxResolvedAt`, `fxManual`, via `fxSnapshot`); later documents of the same chain (advance, final invoice) reuse it and never re-resolve. Cleared only when the proforma is deleted in FGO.
    - **Manual rate:** explicit Admin input only — glass: optional field when requesting the document that sets the rate (rejected with `RATE_LOCKED` once a rate is stored); profile: "retry in FGO" / manual proforma. Overrides any policy, no markup added, stored as `MANUAL` + `fxManual`.
    - **Customer-visible FX wording (decisions.md #99) — never show the markup percentage to the customer** (offers, PDFs/Excel, FGO documents); the real policy and percentage appear only on Admin screens. Offer note for EUR offers (glass offer view, offer PDF/Excel, profile offer, profile order form) comes from the policy via `fxOfferNote` (`lib/fx-note.ts`, texts `fx.offerNote.*`): BT sell rate / BNR rate / "contractual exchange rate" for BNR + %. FGO document sentence comes from the snapshot via `fxDocumentText`: "Curs de vânzare BT: {rate} RON/{cur}", "Curs BNR: {rate} RON/{cur} (data {BNR date})", and "Curs de schimb aplicat: {rate} RON/{cur}" for BNR + % and manual override. Glass FGO documents carry no FX sentence (Text = order title only, #26).
    - Customer-level documents (one document for several orders) are #31 (pre-loading proforma) and #32 (invoice from a confirmed loading); they reuse the snapshot of their chain.

31. **Customer-level pre-loading proforma (Phase 7D-2, decisions.md #100):** Admin selects a customer and one or more future loading days on `/admin/muhasebe/cam/proforma` (`ACCOUNTING_MANAGE`) → preview → ONE FGO proforma for that customer's eligible glass orders.
    - **Model:** `BillingBatch` (customer, kind `PROFORMA`, status `PENDING | ISSUED | FAILED | VOID`, source currency, selected loading days, selection fingerprint, totals, FX snapshot — same fields as #30) + `BillingBatchOrder` (order, order no, offer version, planned day at creation, amount, `activeKey`) + `BillingBatchLine` (copy of the lines sent to FGO). `FgoDocument.orderId` is optional: a document belongs either to an order or to a batch (`batchId` unique) — never attach a batch document to an arbitrary order. `BillingBatch.confirmationId` exists for 7D-3 (invoice from a confirmed loading) and is unused.
    - **One calculation:** preview and document both come from `previewBatch` (`server/glass/batch.js`); lines per order = `proformaLines` (same rule as the order proforma), never merged across orders; every line description starts with "Comanda {orderNo} — "; factory cost never enters the copy. The batch is an immutable copy: the worker (`dispatchBatchJobs`, outbox `FGO_BATCH`) issues the document only from stored lines and the stored rate — never re-resolve FX or re-read offers.
    - **Eligibility** (`planOrder`): planned on a selected day, not cancelled / on hold, loading not confirmed, has the sent offer (`sentOffer`), customer price on every non-free line, EUR or RON, not covered by another document. Excluded orders are shown with the reason. Mixed currencies are blocked (`MIXED_CURRENCY`); an unavailable rate blocks creation (`FX_UNAVAILABLE`, manual rate allowed).
    - **Duplicate coverage — one check (`coverageOf`):** an order with its own FGO document or pending order-level request, or in an active (non-VOID) batch, cannot enter a batch; an order in an active batch gets no order-level document (`billingState` → `batch`). Idempotency: customer + per-order advisory locks (same lock as order-level requests), preview fingerprint (`STALE_PREVIEW`), DB uniques (`BillingBatchOrder.activeKey`, `FgoDocument.batchId`), FGO `IdExtern = LOT-{batchId}`.
    - **Accounting:** the batch document appears once in Cam Tahsilat; `receivables()` groups by order or batch. Status sync is the existing `refreshDocuments`. A document deleted in FGO (manual refresh) removes only the document record and voids the batch (`removeDeletedBatchDocument`); orders become eligible again; orders, offers, loading plan and confirmations are untouched. A `FAILED` batch keeps its orders until Admin retries or voids it (`reviewFailedBatch`).
    - Advance and invoice for orders covered by a customer proforma: #32.

32. **Customer invoice from a confirmed loading + customer document chain (Phase 7D-3, decisions.md #101):** code `server/glass/invoice-batch.js` (+ worker `dispatchBatchJobs` in `server/glass/batch.js`); UI = "Faturalama" card on the confirmed loading day (`app/(panel)/yuklemeler/LoadingBilling.tsx`, `ACCOUNTING_MANAGE`).
    - **Source of truth:** only `LoadingConfirmation` + `LoadingConfirmationItem` with `status = LOADED`. Never the planned date, the current order / offer / price table or the "+2 days" rule. Partial loading: only the LOADED quantity of that confirmation is invoiced; the rest is invoiced from the confirmation in which it is later loaded. Billing never edits or deletes a confirmation or its items.
    - **Grouping:** one invoice per confirmation + customer. Sources that cannot be added together become separate invoice groups (never average rates, never net across currencies): source currency and document chain (which customer proforma, or none). Key `INVOICE:{confirmationId}:{customerId}:{currency}:{proformaBatchId|DIRECT}`.
    - **One calculation:** preview and document both come from `loadingBilling`; `createInvoiceBatch` stores the immutable copy (`BillingBatch` kind `INVOICE`, `confirmationId`, `parentId`, `uniqueKey`; `BillingBatchLine` with `orderId`, pieces, source amount, RON net / gross, `refBatchId`), and the worker issues only from stored lines and the stored rate. Lines per order = the existing order-invoice rule (`invoiceLines` on `itemAsLine` rows: glass only, operations folded into their glass line, VAT-inclusive `PretTotal`) — no new pricing rule; never merged across orders; names start with "Comanda {orderNo} — "; document text "Comenzi: …. Încărcare confirmată: dd.mm.yyyy." (no FX sentence). Factory cost never enters the copy.
    - **FX:** an invoice in a customer-proforma chain reuses that proforma batch's FX snapshot (never re-resolved); a direct invoice resolves once through `resolveExchangeRate` when the batch is created (manual rate allowed) and stores the snapshot; RON has no conversion.
    - **Chain proforma → advance → invoice:** the invoice covers only the scope loaded in that confirmation; the proforma's remaining orders stay covered by the proforma and are invoiced from later confirmations (the chain is not marked fully invoiced). Advance invoice (`createAdvanceBatch`, kind `ADVANCE`, `parentId` = proforma batch): amount = FGO paid value on the proforma − amount already advanced — never a manual or invented amount; allowed before or after loading. While un-advanced payment exists the invoice is blocked (`ADVANCE_REQUIRED`; `ADVANCE_PENDING` while an advance is queued / failed). The invoice offsets issued advances with negative "Stornare avans conform factură {no}" lines, FIFO, each capped at the invoice value; the unused part stays for later invoices of the chain (`chainState`). Do not invent other accounting behaviour.
    - **Order-level chains:** order-level and customer-batch billing are mutually exclusive for the same commercial scope. An order is excluded from the customer invoice (`ORDER_CHAIN`, invoiced from the order page) only while that scope is actively covered by an order-level chain — decided by the shared `coverageOf` (an existing FGO document or a pending order-level request), never by "has ever had a document": a document deleted in FGO or a failed / abandoned request releases the order. Invoice line format and the advance offset rule above are confirmed by the product owner — do not change them; an order in an active invoice batch gets no order-level document (same `billingState` → `batch`).
    - **Idempotency:** customer + per-order advisory locks, preview fingerprint (`STALE_PREVIEW`: lines, rate, advance offset), DB uniques (`BillingBatch.uniqueKey`, `BillingBatchOrder.activeKey = INVOICE:{confirmationId}:{orderId}`, `FgoDocument.batchId`), FGO `IdExtern = LOT-{batchId}`.
    - **Receivables:** a chain (proforma + its advances + its invoices) is ONE debt unit (`unitOf` / `chainShares` in `server/accounting/receivables.js`): advances and invoices count with their own totals; the proforma counts only the not-yet-invoiced scope minus the advance not yet offset; its remaining also drops by payment not yet advanced. Never sum the chain's `FgoDocument` rows directly.
    - **FGO deletion / failure:** a deleted batch document (manual refresh) removes only the document record and voids the batch, so the scope (invoice) or the payment (advance) becomes available again; a proforma that already has advances / invoices stays as the chain root. A `FAILED` batch keeps its scope reserved, shows the real FGO error, and is retried or abandoned by Admin (`reviewFailedBatch`).
    - **Not implemented:** manual "payment received" for a customer proforma, pulling an order-level chain into the customer invoice, storno / correction invoices (7F-2). Correction of a confirmed loading: #34.

33. **Not-loaded glass replanning + cross-customer crate (Phase 7E, decisions.md #102–103).** Both are LOGISTICS; neither changes order / customer / commercial ownership, accounting or FGO billing.
    - **Partial confirmation:** on the confirmation preview Admin enters, per **glass (m²) line**, the not-loaded quantity + reason (`NOT_LOADED_REASONS` = `BROKEN | MISSING | NOT_READY | OTHER`; `OTHER` needs a note → `notLoadedReason` + `notLoadedNote`). `applyNotLoaded` (`server/loading/confirmation.js`) splits the line into a `LOADED` and a `NOT_LOADED` item; the server re-validates quantity (≤ planned), reason and item. Operation lines (CNC, holes, crate fee) are never split — they stay with the order's first loading. No input = the old "Eksiksiz Yüklendi".
    - **Replan** (`LoadingReplan`, `server/loading/replan.js`, Admin only — `LOADING_CONFIRM`): the whole remaining quantity of a `NOT_LOADED` item is moved to a FUTURE, unconfirmed loading day. It records source item, order, real customer, quantity, m², reason, source day, new day, who, when, status `ACTIVE | CONFIRMED | CANCELLED`. No fake order, the order's own date is untouched, and **the old confirmation is never updated** (it keeps saying 8 loaded / 2 not loaded). Moving = close the old row + create a new one; cancel closes the row; a confirmed replan cannot change. Cancelled / on-hold orders cannot be replanned and are skipped at confirmation.
    - **Future day:** the remainder enters the day view, loading Excel, transport list and confirmation preview with ONLY its own quantity (`planItems(orders, confirmedElsewhere, replans)`, `replanRowsBetween` in `lib/loading.ts`) and the note "… yüklemesinden aktarıldı / Replanificat din …"; commercial values are copied from the source item (`snapshotOfItem`), never from the current offer. Confirming it writes item(s) with `replanId` and marks the replan `CONFIRMED`; a still-not-loaded part is a new `NOT_LOADED` item that can be replanned again (chain: item → replan → item → …, `replanChain`).
    - **Double-loading protection:** same advisory lock as the confirmation, `LoadingReplan.activeKey` unique (one active replan per source), `LoadingConfirmationItem @@unique([replanId, status])`, whole-remainder rule, preview fingerprint includes `replanId`. An order that has items in ANY confirmation (loaded or not) is never planned again from its date (`confirmedDays`) — its remainder comes only through a replan.
    - **Billing / proforma / profit are unchanged:** only `LOADED` items are invoiced and counted (#32, #29) — the remainder is invoiced once, from the confirmation in which it is actually loaded; issued invoices and batches are never touched by a replan; an order in a customer proforma stays in that chain (no second proforma). `mergeConfirmed` never counts a not-loaded part and does not list such an order as "onay dışı".
    - **Cross-customer crate:** physical placement only = a `CrateOrder` row whose order belongs to another customer than `Crate.customerId` (the physical host); no new table. `assignGuestCrate` / `removeGuestCrate` (`server/loading/crates.js`, Admin only): only a crate of the SAME loading day on which the order loads (planned or replanned there) — `NOT_SAME_LOADING` otherwise; own-customer crates stay in the crate form (`OWN_CRATE`). The crate form manages only the customer's own orders, preserves guest links, and refuses to delete / renumber a crate that hosts another customer's order (`HAS_GUESTS`). Changing an order's loading day removes its guest placement (`moveOrderCrates`).
    - **Never derive ownership from a crate:** invoice grouping, `coverageOf`, proforma batches, FX policy, profitability and the crate fee (an offer line) always follow the order's real customer. No automatic repricing.
    - **Visibility:** internal roles see "#15 · host" on the order row and the relation in both customer sections (names masked for Sales, no amounts); a **customer** sees only the crate NUMBER of its own order (`guestCratesBetween` strips host identity, crate dimensions / weights and other orders) and a host customer sees nothing about the guest order. Loading Excel: extra "SANDIK (FİZİKSEL)" column (`crateOf`), commercial rows / totals unchanged; transport list: crate stays in the host's group with "+ ORDER (CODE)" in its note; physical weight vs commercial ownership stay separate (confirmed): the host crate's net / gross and the shipping weight include the guest glass (entered real weights win; otherwise `groupLoad(..., { guestKg })` adds it to the host's crates and the owner gets no estimated crate for it), while order count, pieces, m², amounts, invoice and profit stay with the real customer.
    - **Audit:** `REPLAN_NOT_LOADED`, `REPLAN_CANCELLED`, `CROSS_CUSTOMER_CRATE_ASSIGNED`, `CROSS_CUSTOMER_CRATE_REMOVED` (+ internal order events). Confirmed by the product owner — do not change: only physical glass lines are replanned (operations and crate fee are never replanned or re-distributed); target day must be after today and unconfirmed; the original day's row keeps the planned quantity with a "not loaded → day" badge. Correcting a wrong confirmation and replanning only part of a remainder: #34 (the "whole-remainder" and "one active replan per source" rules above are superseded by it).

34. **Operational corrections and exceptions (Phase 7F-1, decisions.md #104–106).** No Romanian accounting rule is invented here: storno / correction invoice / negative invoice / credit note / automatic supplementary invoice / refund / carrying an overpayment as credit / adding a missing order or line to an old confirmation are **7F-2** (after external verification) — do not implement them.
    - **Order-level advance (#104):** for the order-level glass chain the only payment truth is FGO (`FgoDocument.paid` of the proforma). The manual "Ödeme alındı" amount is retired — `GlassBilling.paidAmount` is never read and Admin can never type an amount. One calculation: `orderChain` (`server/glass/billing.js`) → `paid`, `advanced` (Σ `FgoDocument.advanced`, legacy rows: `total`), `advanceRequired`, `nextSeq`; `billingState`, `requestGlassDocument`, the worker and the UI all use it. Advance amount = FGO paid − already advanced; allowed before or after loading; partial payment and later payments produce further advances (`FgoDocument.seq`, unique `[orderId, kind, seq]`, IdExtern `{orderNo}-A`, then `{orderNo}-A{seq}`); sequence and amount are frozen in the request (order lock + queue check = double-click guard) and re-checked when issued. The final invoice is blocked while `advanceRequired > 0` (request and issue time) and carries one "Stornare avans conform factură …" line per advance. `receivables()` sums all advances of the order.
    - **Partial replan (#106):** `replanNotLoaded({ itemId, day, quantity, replaceId })` — any `0 < quantity ≤ free remainder`; several non-cancelled replans per scope, their sum never exceeds the scope's effective NOT_LOADED quantity (checked under the `loading-confirmation` lock); one replan per scope per target day (`LoadingReplan.activeKey = {confirmation}|{scope}|{day}`); `replaceId` moves an existing replan (`closedReason = MOVED`). Each replan enters its day with its own quantity only and is billed only when confirmed LOADED.
    - **Append-only loading correction (#105):** `LoadingConfirmation` / its items are NEVER updated or deleted. A correction = `LoadingCorrection` (confirmation, `revision`, mandatory reason, Admin, time; append-only by the same DB trigger) + NEW `LoadingConfirmationItem` rows (`revision`, `correctionId`, `scopeKey`) for every corrected scope (scope = confirmation + `itemKey`: offer line or replan). **`effectiveItems()` (`server/loading/confirmation.js`) is the single reader of the current state** (highest revision per scope; `upTo` for "as of revision n") — the confirmed card, NOT_LOADED list, replan capacity, `loadedDays`, profitability (`supplierData`), `loadingBilling` and `notLoadedByOrder` use it; never read confirmation items for a calculation without it and never add a parallel "corrected" calculation. Scope of a correction: only the LOADED / NOT_LOADED split of an existing glass scope (loaded + not loaded = confirmed quantity). Code: `server/loading/correction.js` (`planCorrection` = preview and commit share one calculation + fingerprint; `correctLoading`), UI "Düzelt" → preview → save, badge "Düzeltildi #n", history (`loadConfirmation` → `original`, `corrections`). Admin only (`LOADING_CONFIRM`), audit `LOADING_CORRECTED`.
    - **Correction + replan:** more NOT_LOADED → more capacity; less → ACTIVE replans that no longer fit are closed in the same transaction (`CANCELLED`, `closedReason = CORRECTION`, oldest kept); dropping below a replan already CONFIRMED in a later confirmation is rejected (`DOWNSTREAM_CONFLICT`) — downstream history is never rewritten.
    - **Correction + billing = detection only** (`orderImpacts` in `server/glass/invoice-batch.js`): `NO_BILLING`, `ORDER_CHAIN`, `QUEUED_BILLING` (blocks), `FAILED_BILLING` (blocks until Admin retries / abandons), `NO_FINANCIAL_DIFFERENCE`, `UNDER_INVOICED`, `OVER_INVOICED`. For an issued invoice that no longer matches: show "ACCOUNTING ACTION REQUIRED" (`ACTION_REQUIRED`), create / change NO document, and never re-bill the scope automatically — the order keeps its invoice `activeKey` for that confirmation, and glass replanned out of an over-invoiced scope is excluded from the customer invoice of the confirmation where it is later loaded (`heldReplans` → excluded reason `ACCOUNTING_ACTION`; `BillingBatchOrder.loadingRevision` records the revision the invoice was built from). Profitability follows the effective physical state and flags the day (`accounting`).

35. **In-app notifications (Phase 8, decisions.md #107).** One notification system: the source stays `NotificationOutbox` (written in the workflow transaction); e-mail (`server/notifications/email.js`) and in-app (`server/notifications/inapp.js`) are two independent channels over the same events — never duplicate an event or add a second table/poll loop. The worker's `dispatchInApp` fans out events with `inAppAt = null` to `Notification` rows per recipient (`INAPP_RULES`: audiences by permission — customer = active users of the order's firm, drawer = assigned drawer, orderSales = `orderSalesUsers`, admin / sales / accounting / loading sets; the actor never receives their own action except `ACCOUNTING_ACTION`). Worker-side events use `notifyStaff` / `notifyFgoFailed` / `notifyAdvanceRequired`. **Dedupe is in the DB:** `Notification @@unique([userId, dedupeKey])` (`outbox:<id>`, `fgo-failed:<job>`, `advance:<doc>:<paid>`), `createMany({ skipDuplicates })`. **Privacy:** params are stored per recipient — firm name masked for roles without `CUSTOMER_NAME_VIEW`, never stored for customers, no amounts (advance amount only to accounting); text is rendered server-side in the reader's locale (`renderInApp`, order events reuse `events.*`); links are app paths only (`safeLink`) and never authorization — pages check their own permission; `/bildirimler/akis` and the mark-read / sound actions operate only on the session user. **Client** (`components/NotificationCenter.tsx`, pure rules in `server/notifications/feed.js`): no separate polling — the feed is loaded by the panel layout and refreshed by the shared 60 s `AutoRefresh`; when that refresh is skipped it dispatches `takip:poll` and the bell fetches the JSON feed. First load is silent (existing unread = badge only); only unread items first seen after the baseline are "new" → one toast per batch (single or summary) and at most one sound per batch, cross-tab via a `localStorage` mark; sound only after user interaction, failures silent; asset served by `/ses/bildirim` from `server/notifications/sound.js`. `User.notificationSound` (default true; bell switch and customer Settings write the same field) controls sound only. Badge 1…99 / "99+", tab title "(n) <title>" restored when zero; opening the list never marks read. Not implemented: Web Push / service worker, mobile push, WhatsApp, SMS, websocket, a full notifications page.

36. **Compensation glass, special crate, order removal (Phase 9, decisions.md #108–110).**
    - **Compensation (TELAFİ / kırık cam) is NOT `NOT_LOADED`:** a glass of an existing order produced again — before loading, after loading or weeks after delivery. Code: `server/orders/compensation.js` (`createCompensation`, `decideCompensation`, pure rules `compensableLines` / `priceDecision` / `compensationLines` / `destinationCheck`), data `Compensation` + `OfferLine.compensationId`, page data `lib/compensation.ts`. **One workflow, two entry points:** the "Kırık / Telafi" action on a physical glass row (kind CAM, unit m², with dimensions — never CNC / hole / crate-fee / other rows) of the offer **sent to the customer**, and "Kırık / Telafi Camı Oluştur" in the order page's "Önemli kararlar" card (`#kararlar`); both open the same form (`CompensationForm`) and the same action. Sales + Admin (`OFFER_PREPARE`); checked in the action and in the service.
    - **The source order and offer line are never mutated.** Compensation lines are copied from the stored source line (glass, dimensions, weight, list price; its CNC / hole lines copied EXACTLY — #38) — never from today's price table.
    - **Price decision** (`NORMAL | FREE | CUSTOM`; refined by #38): the decision is always about the **customer** price (`priceTier = CUSTOMER`; factory cost is never changed by it). **Sales may choose only NORMAL ("Aynı fiyat": the Admin customer price of the source line, copied server-side) or FREE**; a new customer price (`CUSTOM`) is Admin only (`PRICE_FORBIDDEN` for Sales). Two-tier pricing stays intact — **Sales never receives customer prices** (the form shows no amount to Sales). **FREE = customer price 0, factory cost (`unitPrice`) kept** — `mergePrices` keeps the cost of a free TELAFİ line when Sales saves the offer; profitability shows sale 0 / real cost. FREE and Admin's CUSTOM raise `AdminAlert COMPENSATION_PRICE` (previous customer price → chosen price) + audit; NORMAL raises no price alert; no approval is required for the price itself.
    - **Destination — both options are always offered, the user chooses; never auto-pick the next order:** `EXISTING` = a FUTURE open glass order of the SAME customer (eligibility in one place: `destinationCheck` — not without an offer, other currency, billing coverage via `coverageOf`, confirmed loading, on hold, removed) or `NEW` = a new compensation order numbered from the ROOT order: `ABC124-T`, `-T2`, `-T3` … (`Order.compOfId` + `compSeq`; unique `[customerId, orderTypeCode, customerOrderNo, compSeq]`; ordinary numbering untouched). An unsent offer gets the lines appended; a sent offer gets a NEW sent version (Admin). **Sales cannot change a customer-visible offer:** Sales + sent offer → `Compensation.status = PENDING` (+ `COMPENSATION_PENDING` alert / notification) until Admin approves (the stored customer price is used; Admin may enter another one) or rejects. A new `-T` order is created with its offer in the Admin pricing queue (`YONETIMDE`) — never auto-sent.
    - **After creation there is no parallel compensation workflow:** the lines are ordinary offer lines (only marked; TELAFİ badge for internal users), the order is an ordinary glass order — drawing, loading, crates, confirmation, billing, profitability, notifications use the existing rules. Notifications reuse existing events (`ORDER_OFFER_SUBMITTED` for a new order, `ORDER_OFFER_UPDATED` for a new sent version); do not add a second event for the same thing.
    - **Idempotency:** per-customer advisory lock (same as order numbering), one-time form key (`Compensation.requestKey` unique → a double click returns the first result), DB uniques. A legitimate second compensation is never blocked; previous ones are shown in the form.
    - **NOT_LOADED link (#109):** optional `sourceItemId` / `notLoadedScope`; linked quantity is deducted from the replan capacity (`server/loading/compensated.js`, used by `replan.js` and the compensation service) so the same glass is not produced twice. Confirmations are never touched.
    - **Cross-customer crate** is unchanged 7E (#33): Admin only, physical placement only, shown as "Özel durum — başka müşterinin sandığına ekle" on the loading day.
    - **Order removal (#110):** Admin only (`ORDER_CANCEL`), two-step (`RemoveOrder`: open section → checkbox → red button; the server also requires the confirmation). **Soft:** `server/orders/removal.js` sets `removedAt` and status `IPTAL` (previous status in `removedStatus`); `orderScope` hides removed orders from every role, and everything that already excludes cancelled orders excludes them too. Nothing is deleted or changed: FGO documents, confirmations, corrections, accounting, drawings, audit. No FGO action. Blocked while an FGO / warehouse job is queued (`BUSY`). Restore (removed list on `/siparisler`, or the removed order's URL) returns the previous status and recreates nothing. Never hard-delete an order graph.

37. **Financial documents: order reference, TAKİP e-mail, customer "Documente financiare" (decisions.md #111).**
    - **One e-mail owner: TAKİP.** FGO creates the document; customer-facing proforma / advance / invoice e-mails are sent only by TAKİP. Never enable or rely on any FGO "send e-mail to client" behaviour (`Client[Email]` in the payload is customer metadata only).
    - **Flow:** FGO issues → `FgoDocument` is written → in the SAME transaction one e-mail job per document is queued (`NotificationOutbox` type `FGO_DOC_EMAIL`, `payload.docId`; `queueDocEmail` in `server/documents/delivery.js`) → the worker sends it (`dispatchDocEmails`). Glass order documents, customer batch documents and **profile** documents all use this one path. No `FgoDocument` (failed / pending / abandoned issuance) = no e-mail, no customer entry, no "document ready" notification. The generic `ORDER_PROFORMA` / `ORDER_INVOICED` notification e-mail is skipped when the document was issued through FGO (one e-mail per document); manual profile proformas (no FGO document) still use it.
    - **E-mail:** Romanian; document type (Proformă / Factură de avans / Factură), series + number, issue date, order number(s), total + currency, the **PDF attached** and a link to `/belgeler`. The PDF is fetched server-side (`fetchDocPdf`: stored link, FGO hosts only; missing / 404 link → refreshed with `factura/print`, read-only). After two failed PDF attempts the e-mail goes without attachment, with the document link. Recipient = `financialRecipient(customer)`: `Customer.billingEmail`, else `Customer.email` (#39). No valid address → job closed as `NO_EMAIL` ("Email yok"), never retried; the document stays valid and visible. No cost, profit, supplier or internal data in the e-mail.
    - **Idempotency:** the automatic job is written once, with the document; jobs are claimed with `claimFgoJob` (atomic + 5-minute lease); FGO status sync, page loads and worker restarts never create jobs. **Manual resend** (`resendDocEmail`, `ACCOUNTING_MANAGE`, the "Tekrar gönder" button in the E-posta column of Muhasebe → Tahsilat) intentionally queues another e-mail (`payload.manual`) — it never calls FGO emitere and never touches numbering, IdExtern or billing; a second job is refused while one is pending.
    - **Admin state** on the receivables row = the document's latest e-mail job (`emailStates`): Gönderildi / Bekliyor / Başarısız / Email yok. No separate e-mail page, no new table.
    - **FGO article description:** every article whose source order is known carries `Continut[n][Descriere]` = `Comanda {orderNo}` (`orderDetail`, `emitereForm` line `detail`). In a customer batch each line carries ITS OWN order (`batchFgoLines`, from the stored `BillingBatchLine.orderId`); lines without a single source order (batch advance, advance offset) have none. Denumire, UM, quantity, price, VAT, FX, totals, numbering and IdExtern are unchanged — do not move the order number into Denumire or Text rules.
    - **Customer page "Documente financiare"** (`/belgeler`, the customer-account permission `ACCOUNT_SETTINGS` — customer role only, no new permission key; `server/documents/customer.js`): a read-only view over `FgoDocument` (glass + profile in one list) — type, number, issue date, order(s), total, currency, payment status from the existing FGO sync (`paymentStatus`; a proforma replaced by its invoice shows "Facturată" via `receivables()`), "Vezi PDF". It is NOT customer accounting: no ledger, balances, payment entry or extra tables, and the page never calls FGO. **Privacy:** ownership is a server-side query condition (`ownedBy`: order's customer or batch's customer) and is re-checked by the PDF route (`app/(panel)/belgeler/[id]/pdf`) — a foreign document / order / batch id returns 404. The route serves the PDF through the server; only if FGO refuses the server download is the verified owner redirected to the document's own FGO PDF link. FGO errors, jobs, numbering and settings stay Admin-only.
    - **In-app notification:** the same `FGO_DOC_EMAIL` job fans out to the customer's users (`fanOutDocument`, types `DOC_PROFORMA | DOC_ADVANCE | DOC_INVOICE`, dedupe key `doc:<id>`, link `/belgeler#doc-<id>`); never for manual resends; profile orders keep their existing `ORDER_PROFORMA` / `ORDER_INVOICED` notification (no second one).
    - **One-shot invoice number (#28):** `afterInvoiceIssued` runs right after FGO's successful response, BEFORE the document is recorded, in all three workers — the override is cleared even if recording fails. A number FGO rejects stays in the field (decision 87: no other number is tried).

38. **TELAFİ price rule + CNC / hole belong to ONE physical glass (decisions.md #112–113).**
    - **Price (#112):** the authoritative customer price of a compensation glass is the price Admin set on the source order's sent offer. Sales chooses only **"Aynı fiyat"** (`NORMAL`: that price is copied server-side — no new Admin price entry needed, no "price changed" alert) or **"Bedelsiz"** (`FREE`: customer price 0, factory cost kept). Sales can never enter another price (`priceDecision` → `PRICE_FORBIDDEN`; no field in the form). A different customer price is set by Admin through the existing pricing paths only (the form's Admin-only "Başka fiyat", the `-T` order's pricing approval, update offer, approving a pending decision) — never add another pricing system. Bedelsiz (and Admin's different price) is an important decision: `AdminAlert COMPENSATION_PRICE` + audit with source order, glass, quantity, previous customer price, chosen price, actor, time, destination order / loading day. The Sales form shows **no customer price amount** (two-tier pricing, #22); Admin sees "Mevcut müşteri fiyatı: 66,96 EUR/m²" and amounts on the chips. Normal offer pricing permissions are unchanged.
    - **Operation ownership (#113) — no schema change, no second offer / operation engine:** a CNC / DELIK sub-line belongs (by position) to the glass line above it, and **a glass line that carries operations has `adet = 1`**; the operation's `adet` is the count on that single piece. Glass without operations stays one row with its quantity. One rule in `server/orders/rules.js`: `sharedOpsGlasses`, `splitOnePiece`, `offerProblems` → `ops_multi_glass`. **Server:** every offer save (draft, submit, return, approve, update) is rejected with `OPS_MULTI_GLASS` otherwise (`requireOwnedOps` in `server/orders/transitions.js`).
    - **Editor:** "+CNC / +Delik" on a glass row with quantity N > 1 splits one piece off first (N → N − 1 + a one-piece row that gets the operation); the quantity of a one-piece row with operations is locked; "+ aynısı" copies a piece with its operations. **A split is a representation of physical pieces, not a price change:** the split row carries `from` (source line id) and `mergePrices` makes it inherit the source's stored cost (`unitPrice`), customer price (`offerPrice`) and TELAFİ marker — only for the same glass / dimensions / unit; total quantity, m² and amounts stay exactly the same (#39). Excel import is unchanged (imported rows have no operations and may have quantity > 1; the same rule splits them later).
    - **Compensation copies operations exactly** — never proportional, never `ceil()`, never guessed: a glass row without operations yields a compensation without operations (it does not inherit from a sibling piece with holes); a one-piece row with operations yields the same operations (kind, description, count, stored prices). The form's glass options show the physical configuration ("işlemsiz" / "CNC × 1, Delik × 2"). A legacy row whose operations hang on quantity > 1 cannot be compensated (`ambiguousOps` → `AMBIGUOUS_OPS`) until it is split in the offer; no data migration was written (the staging DB is reset before production). Billing, loading and profitability rules are unchanged (operation amounts are still folded into the glass line above).

39. **Split pieces keep the commercial totals + billing e-mail (decisions.md #114–115).**
    - **Split invariant (#114):** splitting a glass row for an operation (5 → 4 + 1) is only a representation of physical pieces; total quantity, total m², customer total and factory-cost total must equal the unsplit row. The rows of one commercial line share `OfferLine.splitGroup` and carry `OfferLine.pieceBase` (pieces before this row: 0 and 4). **One calculation — `offerLineTotals` (`server/orders/rules.js`):** the line's m² is computed from exact dimensions × TOTAL quantity and rounded once (the existing rule, at line level); a row's share is the difference of two rounded running totals (`m² = area(base + qty) − area(base)`, `amount = amount(end) − amount(start)`), so the rows always sum to the unsplit value — no cent compensation. `pieceBase` is recomputed **server-side on every offer save** (`assignPieceBases`; a posted base is ignored); a group is valid only for the same glass + same dimensions + unit m² (otherwise the row is an ordinary row; a lone row too). Ordinary rows (`pieceBase = 0`) compute exactly as before — never change the per-line rounding rule globally and never add a second area formula.
    - **Documents:** a continuation row of a split line is NOT a separate proforma line / invoice part — `proformaLines` and `glassGroups` (`server/glass/billing.js`) add it to the preceding same-price row (matched by `pieceStartArea`), so proforma, invoice, loading Excel and profitability are identical to the unsplit offer, including RON rounding. `LoadingConfirmationItem.pieceBase` copies the row's base (`snapshotLine`, `snapshotOfItem`, `itemAsLine`) so confirmed loading, customer invoice and profitability follow the same rule. A different price or "bedelsiz" on a split row is a real commercial change (m² still from the group total; amount with the row's own price). Partial loading (LOADED / NOT_LOADED split of a row) keeps its existing rule.
    - **Billing e-mail (#115):** one optional field `Customer.billingEmail` ("E-mail facturare"), edited in the existing Admin customer form (billing section; `CUSTOMER_MANAGE`, validated server-side, audited). **Recipient of financial documents only** (proforma, advance invoice, invoice) = `financialRecipient` in `server/documents/delivery.js`: `billingEmail` if valid → else `Customer.email` if valid → else `NO_EMAIL`. Never fall back to user login addresses. The recipient is resolved when the job is sent, so an issued "Email yok" document is delivered after Admin adds the address and clicks "Tekrar gönder" (existing `FgoDocument`; no FGO emitere, no change to number, IdExtern, FX, totals or billing state). Users' `emailNotifications = false` never suppresses financial-document e-mails. `billingEmail` is delivery metadata only — it grants no authentication and no document access (ownership stays `ownedBy`). Do not add a contact table, another settings page or a second e-mail queue.

40. **Security hardening (3.46.0, decisions.md #116–121; audit report: project doc `guvenlik-denetimi-3.45.0`).**
    - **Client IP (#116):** Caddy is the only trusted proxy boundary. `clientIp` (`server/security/client-ip.js`) reads only `X-Forwarded-For` and takes the **rightmost** value; `CF-Connecting-IP`, `CF-IPCountry`, `X-Real-IP`, `True-Client-IP` are never trusted (and are stripped in `deploy/Caddyfile`). Throttle, depot limit, audit and login-language detection all use `requestIp()` — never read an IP header anywhere else. Cloudflare may only be enabled deliberately: firewall to Cloudflare ranges + Caddyfile change + `CLIENT_IP_SOURCE=cloudflare` (all three).
    - **Passwords (#117):** `server/auth/password-policy.js` — minimum 10, maximum 200 characters, passphrases allowed, no composition rule (only ≥ 4 distinct characters). Applied only when a password is SET; never at login; no forced reset; scrypt unchanged.
    - **Sessions (#118, #135):** `server/auth/session-policy.js` — absolute 30 days, idle **30 minutes of no genuine user activity** (see #47; requests never extend the session); the existing worker prunes dead sessions hourly (`pruneSessions`). The session user object never carries `passwordHash` or the firm's internal commercial fields.
    - **Uploads (#119):** every upload goes through `storeFiles` → `checkUpload` (`server/files/limits.js`) BEFORE anything is written or scanned: 20 files / request, 100 MB / file, 2 GB + 400 files / order, depot link 200 MB + 40 files / order, customer firm 120 files + 1 GB / hour and 3 GB / day, staff user 400 files + 4 GB / hour and 12 GB / day, free-disk floor `UPLOAD_MIN_FREE_MB` (default 1024). Quotas are computed from existing file rows (no Redis, no new table). A user is a customer by `User.type`, not by `customerId` (staff belong to the factory firm). Never delete files automatically.
    - **Customer fields (#120):** one rule, `customerView` (`server/orders/customer-view.js`; `sanitizeCustomer` uses it). `PRIVATE_CUSTOMER_FIELDS` (contact, billing, `billingEmail`, `fxPolicy`) are nulled + name masked for roles without `CUSTOMER_NAME_VIEW`; `INTERNAL_CUSTOMER_FIELDS` (`fxMarkupPercent`, `priceTableId`, `profilePriceTableId`, `groupName`) are nulled for everyone without `CUSTOMER_MANAGE` — including the customer itself and Inspector. A new Customer column must be added to one of the two lists (or be deliberately public) and to `customerSecrets()` in `e2e/helpers.ts`. Sales / Drawing do not see the EUR FX offer note (it reveals the policy).
    - **Financial PDF route (#120):** ownership check first, then `pdfAccess` (`server/documents/pdf-access.js`): 30 requests / 5 minutes per user (429), 5-minute in-memory cache, fallback redirect only to a `pdfUrl`-approved FGO host.
    - **Login (#120):** one generic failure result (no account / inactive / pending invite / wrong password); the login page never redirects to `/setup`. First sign-in goes through the invite e-mail link `/setup?email=…` or the fixed link on the login page; all code errors share one text and count toward the throttle.
    - **Language (#120):** `/dil` (GET) writes only the cookie; `User.language` changes only through `setLanguageAction` (panel select) or at login. Never add a state-changing GET.
    - **Crates (#120):** customer-facing crate rows include only the customer's own orders (`crateOrdersWhere` in `server/loading/crates.js`).
    - **Backups (#121, ADR 0013):** Drive copies can be encrypted with `age`; **off by default**, enabled only by the owner with `takip yedek-sifreleme kur` (key shown once, off-server copy confirmed, full encrypted backup restored from Drive before activation). Key: `/opt/takip/backup-key.txt` (0600) — never in the backup, on Drive, in git or in logs. Local copies stay plaintext (root-only): the backup folder is 0700 and every file `takip.sh` creates under it — dump, upload archive, `.tmp`, `.age.tmp`, files downloaded / decrypted from Drive — is 0600 from creation (decisions.md #136; a narrow `umask 077` subshell around the creating command, and inside the container for the archive `tar`; never a global umask; `deploy/test/backup-permissions.sh` checks it). Never delete historical unencrypted backups automatically; with encryption on, Drive retention touches only `.age` files. Backup-script changes are verified by `.github/workflows/deploy-test.yml` (keep it green: `shellcheck -S warning`).
    - **Deferred (do not implement without a decision):** SEC-03 admin MFA / passkey, SEC-08 CSP, SEC-12 Docker privilege restructuring (done for the worker only: non-root — #48, `cap_drop: ALL` + `no-new-privileges` — #49; the other containers, read-only root filesystem and resource limits are still deferred), SEC-13 least-privilege DB role, SEC-14 ClamAV fail-closed, SEC-16 audit UI.

41. **Admin bulk price + Admin "Çizim Paneli" (3.47.0, decisions.md #122–123).**
    - **"Tek fiyatı tüm satırlara uygula"** exists in the Sales and the Admin offer table (same toolbar position, same label). One rule: `applyLinePrice` / `isM2Glass` in `server/orders/rules.js` — the price typed into an m² glass row is written to every non-free m² glass row; CNC, hole, piece-priced rows (crate fee) and free rows never change. Sales writes `unitPrice`, Admin writes `offerPrice` (customer price; the sales price / cost is never touched). It is a screen convenience only — no pricing engine, validation or visibility rule changed.
    - **Drawing panel for Admin:** no second dashboard. The Drawing team's panel is `/siparisler`; a user with `DRAWING_WORK` whose own page is different (Admin) opens the same page with `?panel=cizim` (sidebar section "Çizim Ekibi"). Same scope (`DRAWING_SCOPE` in `server/orders/scope.js`), same queues (`queuesFor` with `allDrawers`), rows sanitized for the viewer (Admin: full company names; Drawing: masked). Roles without `DRAWING_WORK` ignore the parameter. Admin-only queues, alerts and the removed-orders list are not shown in the panel. `NavLinks` highlights a link with a query only when the page and all its parameters match.

42. **"Özel durum" host firm, order selection, uninvoiced reminder (3.48.0, decisions.md #124–126).**
    - **Cross-customer crate is two steps (#124, refines #33):** (1) **Admin picks the host FIRM** on the order page — the `#ozel-durum` form right below the offer table (`GuestHostFields`, `setGuestHostAction` → `setGuestHost` in `server/loading/crates.js`, `LOADING_CONFIRM`): a checkbox reveals a list of OTHER customer firms that load on a day this order loads (`guestHostOptions` / `firmsLoadingOn`; one firm once; never an order or crate list). Stored in `Order.guestHostId` (no table); no crate is needed. (2) **Sales (or Admin, `CRATE_EDIT`) picks the CRATE** on the loading day, in the host firm's `.guest-box` (`guestCrateAction` → `assignGuestCrate`): only a crate of `Order.guestHostId` on that same loading day — `NO_HOST` / `NOT_HOST_CRATE` / `NOT_SAME_LOADING` otherwise. Sales can never choose or change the host firm; Sales may clear the crate choice (`removeGuestCrate`, back to waiting). One guest crate per order per day (a new choice replaces the old). **Never auto-assign a crate.** Until a crate is chosen: red `.guest-waiting` alert on the day, red badge on the order row, a "waiting" line in the transport list (a replanned remainder waits only if the host also loads that day). Changing / removing the host removes the placement. Ship-day change (`moveOrderCrates`): the old day's placement is removed; the host is kept if it loads on the new day, otherwise cleared and audited (`CROSS_CUSTOMER_HOST_REMOVED`, `SHIP_DAY_CHANGED`). `guestHostId` never reaches a customer (`sanitizeOrder`, `hideHost` in `lib/loading.ts`).
    - **Both customers are notified** when the crate is chosen / changed / removed: outbox events `GUEST_CRATE_ASSIGNED` / `GUEST_CRATE_REMOVED` (written in the same transaction) → `fanOutGuest` in `server/notifications/inapp.js` (in-app only, no e-mail). Guest firm: own order no + crate no + day, never the host's name. Host firm: ONLY guest company name, guest order no, crate no, loading day — the notification is not linked to the guest order (`orderId` null) and carries no price / offer / document / file. Dedupe = outbox id; an unchanged choice writes no event. Choosing the host firm alone notifies no customer.
    - **Transport list:** guest cargo is a separate line under its physical crate (`crates[].guests`, PDF "MİSAFİR YÜK: firm · order" / RO "ÎNCĂRCĂTURĂ SUPLIMENTARĂ"); the firm name is written per viewer (`label` → masked for Sales). Weight rule unchanged (#33). Everything commercial stays with the real customer; crate sharing grants no access to the other customer's order.
    - **Order selection for proforma / invoice (#125):** no second billing engine. `previewBatch` / `createBatch` take `orderIds`, `loadingBilling` / `createInvoiceBatch` take `select: { key, orderIds }` / `orderIds` — the selection only NARROWS the orders the existing calculation found eligible; totals, FX, advance offset and the fingerprint are computed from the selected orders. A selected order that is not eligible / already covered / in another group (currency, FX chain) / already invoiced / held → `NOT_ELIGIBLE`; nothing selected → `NOTHING_SELECTED`; preview ≠ submitted selection → `STALE_PREVIEW`. Unselected orders are untouched and stay eligible (`unselected`). A partial invoice uses a selection-specific `BillingBatch.uniqueKey` (`group.uniqueKey`) so the remaining orders of the same confirmation can be invoiced later; double billing is still prevented by `BillingBatchOrder.activeKey`. No selection = old behaviour (all eligible). UI: checkboxes bound to a GET "Seçimi uygula" form (selection lives in the URL: `sec` / `sip`, `fk` / `fsec` / `fs`). Order-level chains have no selection (one order per document).
    - **Invoice scope decision is one function:** `invoiceScope` (`server/glass/invoice-batch.js`) — `IN_INVOICE` / `EXCLUDED(reason)` / `OPEN` — used by `loadingBilling` and by the reminder. Never write a second eligibility rule.
    - **Uninvoiced loading reminder (#126):** `server/accounting/uninvoiced.js`. Setting `IntegrationSetting 'accounting'` → `uninvoicedDays` (default 6, 0–60; Admin → Entegrasyonlar `#muhasebe`; FGO settings untouched). Scope = confirmation + order, from the EFFECTIVE `LOADED` items (`effectiveItems`); due day = `LoadingConfirmation.shipDay` + days (never the planned date). Closed ONLY by a final invoice: an ISSUED customer invoice batch for that scope, or the order's own `FgoDocument` `INVOICE`. Proforma, advance, queued / failed invoice do not close it. No warning for unloaded / replanned-but-not-loaded glass, scopes with nothing invoiceable (`NO_LINES`, currency) or accounting-action holds. Shown as the persistent `#fatura-bekliyor` list on Muhasebe → Cam Tahsilat (`uninvoicedLoadings`; disappears when invoiced; no manual "done"). The worker (`uninvoicedTick`, hourly; skipped with `--once`) calls `remindUninvoiced` → in-app notification `INVOICE_OVERDUE` to the `accounting` audience only, once per scope (`uninvoiced:<confirmation>:<order>:r<revision>`). It never calls FGO and never creates a document.

43. **Automatic note translation (3.49.0, decisions.md #127).** Scope: ONLY the Notes conversation on the order page (`OrderNote`). Do not extend it to drawing annotations, offer-line notes, additional-info fields, e-mails or notifications without a decision.
    - **Direction comes from the author's ROLE, never from language detection** (`translationTarget` in `server/notes/translation.js`): Customer → Turkish (`tr`); Admin / Sales / Drawing → Romanian (`ro`). The source language is not sent (Google detects it); the original `text` is never modified.
    - **Translate once, persist:** `addNote` saves the note first, then (translation enabled + key saved + note not internal) translates it once and stores the result on the same row (`translation`, `translationLang`, `translationStatus` `PENDING | DONE | SAME | FAILED`, `translationError`, `translationAt`). Page loads / refreshes NEVER call the provider — the page only renders stored fields. Historical notes are not translated retroactively.
    - **Failure never blocks or loses a note:** timeout (6 s), quota, key and network errors become a safe code on the note (`FAILED` + `TRANSLATE_ERRORS`); nothing retries automatically. Internal staff (role with `NOTE_ADD` + `NOTE_INTERNAL_VIEW`) may ask once more with "Çeviriyi yeniden dene" (`retryNoteTranslation`: atomic claim, only `FAILED` or a `PENDING` older than 2 minutes, audited `NOTE_TRANSLATION_RETRY`). A completed translation is never redone.
    - **Visibility — one rule, `noteView` / `notesFor` in `server/notes/view.js` (used by `sanitizeOrder`; refined by decisions.md #128, #130):** a translation can never be more visible than its note. Internal notes are never translated and never sent to Google; their translation fields are stripped for every role. Translating staff = role with `NOTE_ADD` + `NOTE_INTERNAL_VIEW` (Admin, Sales, Drawing): for a CUSTOMER's note they see the Turkish translation, state and error code. **A staff note's Romanian translation exists for the customer and is never shown back to staff (#130):** Admin / Sales / Drawing see their own side's notes in the original only — a completed (`DONE` / `SAME`) Romanian translation returns no translation field to them; only a pending / failed state + error code is returned so "Çeviriyi yeniden dene" still works. Who sees what — staff Turkish note: customer original + Romanian, staff original only, Inspector original only; customer Romanian note: staff original + Turkish, customer original only, Inspector original only. This is display only: when / how a translation is generated and stored is unchanged. **Inspector sees every note only in its ORIGINAL language** — no stored translation, no failure state, no retry UI (fields stripped server-side); Inspector's access to the notes themselves is unchanged. A customer receives only the COMPLETED Romanian translation of a staff note — no error code, no pending state, not the Turkish translation of their own note. Order scope (`orderScope`) is re-checked inside `addNote` / `retryNoteTranslation`.
    - **Only two things may request a translation (#128):** creating a NEW eligible note (`addNote`, once) and an authorized user's explicit "Çeviriyi yeniden dene" on a FAILED note (`retryNoteTranslation`). (Admin's "Bağlantıyı dene" translates a fixed harmless phrase and reads no note.) Page load, browser refresh, the shared 60 s `AutoRefresh`, notification polling, server-component rendering and the worker must NEVER translate: the order page and `lib/orders.ts` import only `server/notes/view.js` (pure — it must not import the provider, env or DB); the provider is imported only by `server/notes/translation.js`, which is called only from the two `'use server'` action files; the worker never imports `server/notes/*`. DONE / SAME are never translated again; FAILED never retries automatically; notes without translation metadata are never translated when viewed. `test/note-translation.test.js` enforces this structure — keep it green rather than loosening it.
    - **UI:** in `.note`: "Özgün mesaj" / "Mesaj original" label, the original, then `.note-translation` (secondary) with the label in the TRANSLATION's language regardless of UI locale — "Türkçe · otomatik çevrilmiştir" / "Română · tradus automat" (`translate(lang, 'order.notes.translatedLabel')`; keep these two texts exactly).
    - **Provider / secret:** Google Cloud Translation Basic v2 (`server/notes/provider.js`), server-side only; the API key goes in the `X-Goog-Api-Key` header, never in a URL, log, error text, audit record or response. It is entered only on Admin → Entegrasyonlar → "Not çevirisi" (`IntegrationSetting 'translate'`, sealed with `server/crypto/secret.js`, shown only as "kayıtlı"); `getTranslateSettings` returns only `{ enabled, hasKey }`. Save / test require `SETTINGS_MANAGE` (checked in the action and in the service). "Bağlantıyı dene" translates a harmless phrase and reads no note.
    - **Tests never call Google:** `TRANSLATE_FAKE=1` selects `fakeTranslate` (no network; set in CI; the Integrations card shows a "TEST MODU" warning; production warns if it is set). Unit / DB tests inject the provider or a fake `fetchImpl` and run under a fetch guard.

44. **Official GKH branding in PDFs and e-mails (3.49.1, logo replaced in 3.49.2; decisions.md #129, #131) — permanent rule:** *All TAKİP-generated HTML e-mails and TAKİP-generated company PDF documents must use the official GKH Trading Invest branding/logo through the shared branding infrastructure where technically applicable.*
    - **One source:** canonical asset `assets/brand/gkh-trading-invest-logo.png` (1596 × 643, transparent PNG: building mark + dark "GKH Trading Invest" lettering). It is the owner's file `assets/brand/source/logo-seffaf.png` with ONLY the white lettering recoloured dark (`#111827`) — the owner's choice, because white lettering is invisible on white paper / e-mail; size, per-pixel transparency and the building are identical (the test compares both files pixel by pixel). Never use the white-lettering source in an output, never convert the logo to JPEG, never put it on a dark band without a decision. `scripts/brand-logo.mjs` expects exactly ONE file named `gkh-trading-invest-logo.png` (or `.jpg`) in `assets/brand`; embedded copy `server/branding/logo.js` (GENERATED by `node scripts/brand-logo.mjs` — never edit by hand; `test/branding.test.js` fails if it differs from the asset); accessors in `server/branding/index.js` (`BRAND`, `brandLogoBytes`, `brandLogoSize`). Never reference an upload / temporary / local path or an external URL for the logo; never stretch or crop it (size is always derived from its own aspect ratio). To change the logo: replace the asset file and run the script — nothing else.
    - **PDF:** `server/pdf/brand.js` (`brandImage(doc)`, `drawBrandLogo(page, logo, { x, y, height, align })`). Every generator in `server/pdf/` uses it: offer (`offer.js`), Comanda Depozit (`depot-form.js`), transport list (`transport-list.js`, top-right on every page, with the official company name `BRAND.company` = "GKH Trading Invest SRL" beside it — the route never passes a hand-written name). A new PDF generator must use the same helper (the test lists the generators) and must place header text from the width `drawBrandLogo` returns, never a fixed offset. The logo is embedded in the document with its transparency (`/SMask`; `server/pdf/pdf.js` keeps PNG alpha instead of flattening to white). Branding never changes calculations, quantities, prices, VAT, FX or FGO behaviour. **PDFs produced by FGO (proforma / invoice) are not TAKİP documents and are never modified.**
    - **Sender identity (3.50.2, decisions.md #133):** every TAKİP e-mail is sent as `GKH Trading Invest SRL <address>` — display name = `BRAND.company`, address = the configured `MAIL_FROM` address, unchanged. Applied in ONE place, `mailSender` inside the send point (`brandMessage` in `server/mail/layout.js`), for HTML and text-only mail; a name written in `MAIL_FROM` is ignored. Never build a "Name <address>" From in a template or mail path (the test checks), never add a Reply-To unless a decision says so (a `replyTo` passed by a caller is carried through untouched).
    - **E-mail:** one layout `server/mail/layout.js` (`brandedHtml({ lang, title, body })` — templates produce only the body) and ONE send point `sendBrandedMail(transport, msg)` (`server/mail/send.js`): the logo goes as an inline CID attachment (`gkh-logo@takip`, PNG, last in `attachments` so a PDF stays first; 200 px wide, on an explicitly white header cell, document marked light-only via `color-scheme` because the lettering is dark); an HTML that is not branded is wrapped at send time; text-only mail is untouched. All paths use it: order notifications (`server/notifications/email.js`), financial documents (`server/documents/delivery.js`), warehouse (`server/profile/warehouse.js`), invite / code (`server/mail/sendInvite.js`). **Never call `transport.sendMail` anywhere else** and never write an `<html>` skeleton in a template (both enforced by `test/branding.test.js`). Branding must not change recipients, triggers, timing, preferences, privacy or the plain-text part.

45. **Document deleted manually in FGO → "TAKİP'ten kaldır" (3.50.0, decisions.md #132).**
    - **Meaning:** the action removes the LOCAL `FgoDocument` record only. TAKİP never deletes / cancels a document in FGO: there is no FGO delete endpoint in the code and none may be added (`test/fgo-doc-removal.test.js` lists the FGO endpoints in use: `factura/emitere`, `factura/print`, `factura/getstatus`).
    - **One service:** `removeDocumentDeletedInFgo` (`server/accounting/receivables.js`), called only by `removeDeletedDocAction` (`app/(panel)/admin/muhasebe/actions.ts`). `ACCOUNTING_MANAGE` (Admin only) is checked in the action and in the service; the server also requires the confirm field. The worker never calls it; nothing is removed at deploy / by migration.
    - **Verify, fail closed:** it re-queries FGO for that exact series + number (`fgoStatus`, one request, no retry) and removes the record ONLY on the definitive absent answer (`fgoDocumentAbsent`). Document still in FGO → `EXISTS`, not removed. FGO disabled / no key / network error / timeout / 5xx / 429 / auth error / unreadable or ambiguous answer → `UNVERIFIED`, nothing changes. Never treat a temporary or ambiguous FGO failure as proof of deletion.
    - **Cleanup = the existing path only:** `removeDeletedDocument` (`server/integrations/fgo-deleted.js`) — the same helper "FGO ile Güncelle" and `reserveInvoiceNumber` use (order / batch returns to its pre-document state, pending customer e-mail skipped, history + audit). Never add a raw `fgoDocument.delete` elsewhere (the test allows it only in `fgo-deleted.js` and `profile/transitions.js`). If the helper did not remove the record the result is `CLEANUP_FAILED`.
    - **Definitive "absent" rule — one function for every path:** `fgoDocumentAbsent(e)` (`server/integrations/fgo.js`) = FGO's permanent answer (`FgoError`, not `retry`) + a not-found phrase + it names the document (`factur / proform / document / invoice`) + no auth / permission / limit / format word. "Firma nu exista", "Hash invalid", "Prea multe cereri" are NOT proof. The manual refresh and `reserveInvoiceNumber` use the same function — do not go back to testing `FGO_NOT_FOUND` alone.
    - **UI:** only on Muhasebe → Cam / Profil Tahsilat: banner `#fgo-absent` + the row button, shown only when the stored `checkError` says absent (`absentInFgo` — a hint; the decision is always the live check). Fixed result texts; FGO's raw error is never shown. Shares the `fgo-sync` lease with the status sync (`BUSY`). Every request is audited (`FGO_DOC_REMOVE_REQUEST` with the result). No ignore list for the hourly sync: a removed record is simply no longer selected.

46. **Server: Docker build-cache limit (3.50.3, decisions.md #134).** `cache_housekeeping` in `deploy/takip.sh`: build cache ≤ 10 GB → nothing; > 10 GB → `docker builder prune --all --force --reserved-space 4000000000` (older Docker: `--keep-storage`, detected from `--help`), then a full `docker builder prune --all --force` only if still above the limit. No age filter (the old `until=168h` rule freed nothing). **Build cache only:** never add `docker system prune`, `docker volume prune`, `docker image prune -a` or any container / volume removal to the server tool (the tests check the source and, with real Docker, that volumes, image IDs, containers, backups, DB rows and an uploaded file are byte-for-byte unchanged). One function, under the deploy lock: after a successful deploy, after a failed build, once on the next timer tick when the deploy was done by the tool's previous version (`state/cache-checked`), and `takip cache temizle`. Not part of the nightly backup. **Dockerfile:** `deps` installs from the `manifest` stage's version-neutral copy of `package.json` / `package-lock.json` (version forced to `0.0.0`), so the ~1.2 GB `npm ci` layer is reused across releases — never `COPY package.json` straight into `deps` again (the version bump of every release would rebuild it and leave another ~1.2 GB of cache per deploy); the real `package.json` reaches the app through `COPY . .` in `builder`. Changes to `deploy/**` and the `Dockerfile` are verified by `.github/workflows/deploy-test.yml` (`deploy/test/cache-housekeeping.sh` + the real-Docker step) — keep it green.

47. **Inactivity logout: 30 minutes without genuine user activity (3.50.6, decisions.md #135).** No second auth system — same `Session` row, cookie, `getCurrentUser` / `requirePermission`.
    - **Server rule (`server/auth/session-policy.js`):** a session is invalid when `now − Session.lastSeenAt ≥ 30 min` (or the absolute 30 days passed). `lastSeenAt` means "last genuine activity", not "last request". `liveSession` is READ-ONLY (it only deletes a dead row). **The only writer of `lastSeenAt` is `recordActivity`**, reached only through `POST /oturum/etkinlik` (`app/oturum/etkinlik/route.ts` → `reportSessionActivity` in `lib/auth/session.ts`). Never touch / extend the session from a page render, layout, route handler, server action, polling endpoint or the worker, and never add another writer (`test/session-idle.test.js` checks the structure). An expired session is never revived (conditional update); `idle ≥ 30 min` in a report is only a question ("am I expired?") and extends nothing.
    - **What counts as activity (browser, `components/SessionActivity.tsx` + pure rules `server/auth/activity-tracker.js`):** trusted (`isTrusted`) `keydown`, `pointerdown`, `pointermove` with a changed position (`createMoveFilter`), `wheel`, `touchstart`, `touchmove`. **Never:** the shared 60 s `AutoRefresh`, `takip:poll` / the notification feed, script-dispatched events, focus / visibility, page load, an open tab. Do not add an event that fires without the user, a timer-based "heartbeat", or a call to the activity URL from any other component.
    - **Traffic:** no activity → no request. Activity → first report at once, then at most one per minute per tab; the report carries the AGE of the last activity (`{ idle: ms }`) and the server writes `now − idle`, so a delayed report never over-extends.
    - **Expiry:** pages redirect to `/login?info=idle` (`requireUser`), file / JSON routes answer 401, server actions are rejected (they all go through `getCurrentUser`). The open tab asks the server once when its time is up and goes to the login page; a session ended elsewhere (logout in another tab) sends the tab to `/login`.
    - **Multi-tab:** the session belongs to the browser; activity in one tab keeps it alive for all. Tabs share nothing client-side — each learns the remaining time from the server (`remainingMs` prop from the panel layout on every refresh, and the reply to its own report / question).
    - **Endpoint protection:** POST only, custom header `x-takip-activity: 1`, same-origin check (`server/security/same-origin.js`), 30 requests / minute per session. It is the only state-changing Route Handler — everything else stays a server action; a new state-changing Route Handler must use the same origin check.
    - Tests use fake clocks / injected `now` and, in e2e, an aged `lastSeenAt` + `page.clock` — never a real wait.

48. **Worker runs as non-root (3.50.8, decisions.md #137; the worker part of SEC-12).** The background worker runs as the app's user: `deploy/docker-compose.yml` → `worker.user: "1001:1001"`. **The `tools` image and service stay root** (migrations, `takip yonetici`, `takip antivirus`, `takip kur`, backup / restore helpers) — never add `USER` to the Dockerfile `tools` stage or `user:` to the `tools` service for this.
    - **Everything the worker writes to disk is in the uploads volume** (`storeGenerated`: depot PDF + month directory; `quarantine`: `.karantina`) and must be creatable by UID 1001. New worker code must not write anywhere else (no files under `/app`, no reliance on a home directory) and must never assume root.
    - **Ownership migration = the `uploads-init` Compose service** (one-shot; root, `network_mode: none`, only the uploads volume, no env): `worker` depends on it with `service_completed_successfully`, so it runs before the worker on every `compose up` (deploy, restore, rollback-forward). It only runs `find /data/uploads -xdev ! \( -uid 1001 -gid 1001 \) -exec chown -h 1001:1001 {} +`: ownership only — never delete / move / rename / chmod / touch contents, never follow links, never leave the volume; idempotent; always exits 0 (an ownership problem must not block a deploy; it logs `UYARI`). It is a Compose service on purpose: a step added to `takip.sh` would not run on the deploy that introduces it (the running deploy uses the tool's previous copy). Do not move it into `takip.sh`, and do not make the app depend on it.
    - `takip durum` shows the worker's user and the number of entries in the volume not owned by 1001:1001 (`worker_status`, read-only). `takip restore` still ends with `chown -R 1001:1001`.
    - Worker capabilities / `no-new-privileges`: #49. Read-only root filesystem and the privileges of the other containers are still deferred.
    - Tests: `test/worker-nonroot.test.js` and the real-Docker server-install test `deploy/test/worker-nonroot.sh` (+ `worker-fixtures.mjs`; `deploy/test` is excluded from the image by `.dockerignore`, guarded to run only in CI, mail goes to `MAIL_OUTBOX_DIR`, depot recipient is a test address). Keep `.github/workflows/deploy-test.yml` green.

49. **Worker without privileges (3.50.9, decisions.md #138).** **Worker service only** (`deploy/docker-compose.yml`): `cap_drop: [ALL]` + `security_opt: [no-new-privileges:true]`, with `user: "1001:1001"` unchanged (#48). The worker needs no capability: it writes its own files in the uploads volume and is only a network client (DB, ClamAV, SMTP, FGO).
    - **New worker code must keep working with zero capabilities and no privilege gain:** no listening on ports < 1024, no raw sockets, no chown / chmod of files it does not own, no setuid helpers (`sudo`, `su`, `ping`), no reading other users' files.
    - **Scope is deliberate — do not broaden without a decision:** `app`, `db`, `caddy`, `clamav`, `tools`, `uploads-init` keep their settings (`uploads-init` must stay root with capabilities: it changes ownership; `tools` stays root); no read-only root filesystem, no memory / CPU / pids limits, no seccomp / AppArmor changes. `test/worker-nonroot.test.js` fails if `cap_drop` / `security_opt` appear on another service or a resource limit is added.
    - Tests: `test/worker-nonroot.test.js` and the real-Docker `deploy/test/worker-nonroot.sh` (`worker_is_nonroot`: Docker settings + the kernel's view — all five capability sets zero, `NoNewPrivs: 1` — plus scan / quarantine / depot PDF / shared uploads; `others_unchanged`). Keep `.github/workflows/deploy-test.yml` green.

50. **Order history and people are sanitized per role on read (3.50.10, decisions.md #139; audit AUD-1, AUD-2).** One rule: `server/orders/order-view.js`, applied by `sanitizeOrder` (`orderPeopleView`) right after the DB read — never filter history or people in the page / client instead.
    - **People (AUD-2):** for roles without `CUSTOMER_NAME_VIEW` (Sales, Drawing) every customer-side person (`type = CUSTOMER` / role `MUSTERI`; a person without type / role is treated as customer) goes through `personView`: all fields nulled, only the role remains (shown as "Müşteri"). Never fall back from name to e-mail for such a person. Covered: `createdBy`, `files[].uploadedBy`, `drawings[].uploadedBy / sentBy / decidedBy`, `notes[].user`, `events[].user`. A new relation that returns a user on an order must be added to `orderPeopleView` (and selected with the `PERSON` shape in `lib/orders.ts`, which carries `type` / `appRole`).
    - **Events (AUD-1):** `STAFF_EVENT_POLICY` decides per event code who sees the row and who sees the note (pricing notes → `OFFER_DRAFT_VIEW`; FGO document rows → `PRICE_FINAL_VIEW`, their notes → `ACCOUNTING_MANAGE`; FGO request / failure / retry, cost correction, legacy `GLASS_PAID` → `ACCOUNTING_MANAGE` only). **An event code not in the table is visible to accounting only** — every new `h.event(...)` / `event: '...'` code must be added to the table (`test/order-view.test.js` scans the code). Masked roles also get e-mail addresses in notes replaced by `***`. Customer view is unchanged (`EVENTS` flags).
    - **History is protected at read time** — old rows are not rewritten (no migration). New writes carry no sensitive value: `FGO_DOC_EMAILED` note = document number only (recipient stays in the outbox payload), `OFFER_SUBMITTED` has no note (amount in the audit record). Never write a recipient e-mail, an amount or a raw external error into an `OrderEvent.note` again.

## Repository conventions
- Stack: Next.js 15 (App Router, server actions) + Prisma 6 + PostgreSQL 17, Node ≥ 20.9. Pure domain rules live in `server/**/*.js` (plain ESM, unit-tested with `node --test`); Next-bound code in `lib/`, `app/`.
- UI strings only via `server/i18n/{tr,ro}/*.js` — never hard-code visible text. Both locales must have the same keys (enforced by `test/i18n.test.js`).
- Every change to app code bumps `package.json` version and adds a `CHANGELOG.md` entry (enforced in CI).
- Environment variables are declared and validated in `server/env.js`; add new ones there and to `.env.example`. Secrets never go into code, chat or git.
- Schema changes: edit `prisma/schema.prisma`; CI generates the migration on working branches. Hand-written SQL (triggers, constraints Prisma can't express) goes into its own dated migration folder.
- Workflow: every order state change goes through `runOrderAction` (`server/orders/transitions.js`, on top of `server/domain/transition.js`): permission/state check, one DB transaction with history (`OrderEvent` from/to), audit (role + IP) and outbox, optimistic lock on `Order.version`. Server actions only parse forms and map `WorkflowError` codes to messages. Uploads go through `storeFiles` (`lib/uploads.ts` → `server/files/store.js`: content check, SHA-256, ClamAV).
- Hand-written migrations must be timestamped with the current UTC time (CI names generated migrations with its run time; a later-named hand-written file would run after them).
- Authorization: pages/actions call `requirePermission('<PERMISSION>')`; the matrix is `server/auth/permissions.js` (never check role names for access). Data for a page is loaded through `lib/orders.ts` (`loadOrder` / `sanitizeRows`), which strips what the role may not see (masked company, internal notes/files, drafts, admin price).
- Price tables and list prices: `server/pricing/tables.js` (Excel, table choice per salesperson, offer line enrichment — list price is always computed server-side); admin "Important decisions": `server/pricing/alerts.js` (`AdminAlert`, append-only, closed with "Gördüm").
- FGO jobs (glass, customer batch, profile workers) are claimed only through `claimFgoJob` (`server/integrations/fgo-claim.js`): one atomic update (attempts + `availableAt` moved forward as a 10-minute processing lease), so only the claimant calls FGO; a crashed job is retried after the lease. A leased job is `PENDING` + future `availableAt` + empty `lastError` — code that pulls waiting jobs forward must use `WAITING_JOBS` and never touch a leased one.
- Queues ("Sıra bende") are defined in `server/orders/queues.js` (glass orders only — profile orders never reach Sales/Drawing queues).
- UI: one shared visual system — tokens and all shared primitives live in `app/globals.css`; read `docs/UI-DESIGN.md` before any UI work (no colour codes or new one-off styles in pages; reuse `.card`, `.btn`, `.badge`, `.alert`, … and the shared shell `app/(panel)/layout.tsx`).
- Tests never reach real FGO / ANAF / BNR. DB tests pass a fake `fetchImpl` / `bnrImpl` and wrap new tests in `offline(...)` (`test/db/helpers.js`: any global fetch fails the test). In the e2e database FGO is **disabled and must stay disabled** (browser "create document" buttons stop with `FGO_DISABLED`); when an e2e needs an ISSUED document, use `e2e/fake-fgo.ts` — the real services (`createBatch`, `createInvoiceBatch`, `createAdvanceBatch`, `dispatchBatchJobs`) run in the test process with a fake FGO, a network guard and the keys / selection read from the browser-rendered form. Never write an enabled FGO setting into the e2e database.
- Checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db` (needs `TEST_DATABASE_URL`), `npm run e2e`. In CI every step runs through `scripts/ci-step.sh`, which publishes failures as `::error::` and the test totals (also of a green run) as `::notice::` check-run annotations.
