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
12. **Passwords:** minimum 6 characters (at least one letter and one digit). Login and code entry are throttled: 5 failures per e-mail+IP, 20 per e-mail, 30 per IP within 15 minutes.
13. **Company code is exactly 3 letters A–Z** everywhere (DB CHECK constraint). Existing longer/shorter codes were migrated and their order numbers renamed. A company's code cannot change once it has orders.
14. **"Act on behalf of customer"** is postponed to Phase 9.
15. **Allowed upload types** (customer and drawing team): PDF, DWG, DXF, STEP/STP, IGS/IGES, XLS/XLSX, DOC/DOCX, ZIP, JPG/JPEG, PNG; max 100 MB per file. The content must match the extension (`server/files/signature.js`).
16. **Antivirus unavailable → accept, mark "not scanned" (PENDING), scan later** (worker). PENDING files are downloadable with a warning badge; INFECTED files are quarantined and never served. Admin can switch the policy to "reject" on Admin → Integrations.
17. **Glass catalogue is bilingual** (TR + RO name and colour; EN kept in Excel only). Everyone sees glass names in their selected UI language. Glass is identified by TR name + TR colour; weight is kg/m², mandatory, used for loading only (never shown in offers). Inactive glass appears in no list. Order items store a snapshot (both names + weight). Admin imports/exports the catalogue as Excel in the product owner's column layout (`server/catalog/glass.js`, `server/files/xlsx.js`). decisions.md #20–23.
18. **Draft orders** (`OrderDraft`): customer-only, firm-scoped, no number/SLA/history, never in any queue; submitting turns it into an order in one transaction (files move, draft deleted). No "request info from customer" state. decisions.md #24–25.
19. **Price tables (Phase 3b):** admin price tables per glass (+ fixed hole/CNC prices), Excel import, one table per salesperson (else default). Sales quote lines are pre-filled; sales may override, which raises an admin "Important decisions" warning. decisions.md #26.
20. **Crates are entered on the Loadings tab** per loading day + customer (Sales or Admin, `CRATE_EDIT`): crate no (unique per day across customers), L/W/H mm, net/gross kg, note, which orders it carries (`Crate` + `CrateOrder`, `server/loading/crates.js`). Entered crates override that customer's estimate for the day. No crate entry on the order page. When an order's loading day changes, its crates move with it (`moveOrderCrates`; shared crates stay, numbers shift if taken). decisions.md #27.

21. **Drawing workflow (Phase 4):** drawer uploads files to a draft version (`TASLAK`, invisible to customer; several files per version in `DrawingFile`), then "Send to customer" with a confirm dialog (`send_drawing`); every file must be antivirus-CLEAN to send. Sent versions are immutable; drawer may withdraw a sent version with a reason before the customer decides (`GERI_CEKILDI`). Single active drawer → auto-assigned on "send to drawing". SLA overdue = red badge + top of queues only. decisions.md #28–31.

22. **Two-tier pricing as implemented (Phase 5, refines #4):** offer lines are shared between Sales and Admin (Admin may change dimensions/qty/lines and Sales sees it); each line has `unitPrice` (sales price, Sales only) and `offerPrice` (customer price, Admin). Admin cannot change sales prices; Sales never receives offer prices (`lib/orders.ts → offerPrices`), customer/inspector receive only offer prices. Customer-specific price tables (`PriceTable.kind = CUSTOMER`, linked per `Customer`) pre-fill offer prices when Sales submits; otherwise empty. Every line needs an offer price before Send to Customer. Event notes never carry amounts. Prices are shown excl. VAT. decisions.md #32–34.

23. **Profile order (Phase 6a):** number `GLAP12` (separate sequence). Flow FIYAT_BEKLIYOR → TEKLIF_GONDERILDI → (customer approves with pickup date, phone, plate) ONAYLANDI → PROFORMA → (payment / "send to warehouse") DEPODA → TESLIM_EDILDI → FATURALANDI. Prices: product list price (EUR) or a linked customer profile price table; Admin may change; sent offer is an immutable snapshot. EUR offers (glass and profile) carry the Banca Transilvania exchange-rate note; prices excl. VAT. Pickup only on working days, earliest the first working day after payment (moved automatically if payment is late). Warehouse e-mail (PDF Comanda Depozit only, recipients configurable on Admin → Integrations) goes out via the outbox/worker; its one-time depot link lets the warehouse upload the signed receipt and mark delivered. Stock = append-only `StockMovement`; deducted when the order goes to the warehouse, never blocks. Code: `server/profile/*`, `server/pdf/*`. FGO invoicing integration is Phase 6b. decisions.md #35–45.

24. **FGO (Phase 6b):** proforma (series PRF) on customer approval and invoice (series GKH) on delivery are issued automatically through the outbox/worker (`server/profile/fgo-jobs.js`, `server/integrations/fgo.js`) when enabled on Admin → Integrations. Both in **RON**: unit price = EUR offer price × Banca Transilvania EUR sell rate on the proforma day (`server/fx/bt.js`); the invoice reuses the proforma rate. Rate/date/source are stored on `ProfileOrder`. Payment is still marked manually (FGO API cannot read bank payments). FGO rejections are not retried (admin alert + "retry in FGO"); manual buttons remain as fallback. The FGO private key is entered only on the Integrations page and stored encrypted (`server/crypto/secret.js`). Customer billing fields: taxId, regCom, country, county, city, address. decisions.md #46–50.

25. **Accounting (admin only, `ACCOUNTING_MANAGE`):** `/admin/muhasebe/{profil,cam,tedarikci}`. FGO documents are recorded in `FgoDocument` when issued; "FGO ile Güncelle" reads total/paid via `factura/getstatus` (`server/accounting/receivables.js`, reuses `server/integrations/fgo.js`). Loading profit per ship day = sale (admin price) − cost (sales price = factory price table, `Offer.amount`) − transport (`LoadingCost`, manual). Factory balance = total cost − `FactoryPayment` (not linked to loadings). Currencies are never summed together (`server/accounting/supplier.js`). decisions.md #51–54.

26. **Glass FGO documents (no customer approval, order status untouched):** admin buttons on the glass order page (Finans / FGO): not loaded → Proforma; proforma paid (FGO paid > 0 or admin "payment received" with amount) → Advance invoice (single line "Avans marfă…" = paid amount); loaded (ship day + 2 days) → Invoice (glass lines + negative "Stornare avans" line if an advance exists). **Invoices** list only glass (proformas are detailed: each glass line + separate CNC/hole lines): line name = Romanian glass type only (no size/qty), CNC/hole/other amounts are added to their glass line, same glass types merged by m²; FGO Text = order title only. One document per kind per order (advisory lock, state check, `FgoDocument @@unique([orderId, kind])`, FGO IdExtern). Issued by the worker (`server/glass/billing.js`), recorded in `FgoDocument` (same source as Muhasebe → Cam Tahsilat), rate stored in `GlassBilling`, e-mailed in Romanian to `Customer.email` with the FGO link. FGO settings include a daily document limit (test safety). Invoices (GKH, glass and profile) are numbered last number in `FgoDocument` + 1 (or the admin's "next invoice number" if higher; proformas numbered by FGO). Invoice glass lines are built from the same VAT-exclusive per-line amounts as the proforma and sent as VAT-inclusive `PretTotal`, so totals match the proforma exactly. decisions.md #55–63.

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
- Queues ("Sıra bende") are defined in `server/orders/queues.js` (glass orders only — profile orders never reach Sales/Drawing queues).
- Checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db` (needs `TEST_DATABASE_URL`), `npm run e2e`.
