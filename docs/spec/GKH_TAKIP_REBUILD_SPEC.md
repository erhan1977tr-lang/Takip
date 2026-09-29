**Claude Code Master Specification • v1.0 • 29 September 2026**

Target: rebuild the lost GKH Digital order & production portal while
preserving the observed business behavior and adding an extensible
Profile Order module.

# 1. Mission and implementation rules

- Rebuild the application from behavior, screenshots and business rules.
  Do not invent shortcuts that change the workflow.

- The current Glass Order workflow is the compatibility baseline. The
  new Profile Order workflow is a first-class order type, not a bolt-on
  page.

- Implement in phases. Do not attempt the entire product in one pass.

- Use server-side authorization and server-side data masking. Hiding UI
  elements is not authorization.

- All state-changing actions must be auditable. Never silently overwrite
  workflow history.

- Business labels should be configurable and the UI must support Turkish
  first, with an architecture ready for Romanian/English.

# 2. Product concept

After authentication, the customer can create a new order. The New Order
entry point first asks for the order type. Initially two types exist:

| Type          | Code          | Behavior                                                                                                                                           |
|---------------|---------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| Glass Order   | GLASS_ORDER   | Existing glass workflow: customer submission → sales review → drawing when required → sales quote preparation → admin pricing/approval → customer. |
| Profile Order | PROFILE_ORDER | Customer selects profile/accessory quantities → order goes only to Admin → Admin prices → Admin sends priced offer to customer.                    |

Architecture requirement: order types must be extensible so future types
can be added without redesigning authentication, order lists, audit
logging, notifications or customer history.

# 3. Roles and visibility

| Role         | Glass orders          | Profile orders | Pricing                              | Drawings              | Company name                   |
|--------------|-----------------------|----------------|--------------------------------------|-----------------------|--------------------------------|
| System Admin | Full                  | Full           | Final authority                      | Full                  | Full                           |
| Customer     | Own only              | Own only       | Customer-visible offer               | Own order drawings    | Own company full               |
| Sales        | Assigned/authorized   | No access      | Prepares glass quote, not final send | Read/route            | First 3 chars + mask           |
| Drawing      | Assigned/authorized   | No access      | No commercial pricing                | Create/version/revise | First 3 chars + mask           |
| Inspector    | Authorized visibility | As configured  | Read/oversight                       | Read                  | Full, matching observed system |

# 4. Mandatory privacy rule

Sales and Drawing users must never receive the full customer company
name from the API. Masking must happen server-side.

### Examples:

GLASSANDMORE → GLA\*\*\*\*\*\*\*\*\*\*\*  
ALEGRAD → ALE\*\*\*\*  
FOL Expert → FOL\*\*\*\*\*\*\*

Admin sees the full name. Customer sees its own company name. Inspector
currently sees full names. Audit logs may store immutable identifiers;
UI exposure remains permission-controlled.

# 5. Order numbering

Glass orders preserve the existing customer-prefix convention. The
company has a stable three-letter code and a company-scoped sequence.

company.code = GLA  
company_sequence = 68  
order_number = GLA68

Use a database transaction and unique constraint to prevent duplicate
numbers under concurrent submissions. Do not assume strings such as
GLA64-1 are automatically generated child orders; preserve customer
order-number fields separately until a confirmed rule exists.

Profile order numbering should be configurable. Recommended default for
the rebuild: \<COMPANY_CODE\>P\<SEQUENCE\> (example GLAP12), while Glass
remains GLA68. Keep the formatter configurable.

# 6. Customer portal

Observed navigation: Orders, New Order, My Loadings, Archive, Settings,
Help.

## 6.1 New Order selector

New Order opens a selector with two large cards: Glass Order and Profile
Order. The selector must be data-driven from active order_types so
additional order types can be enabled later.

## 6.2 Glass Order creation

- Order title.

- Customer order number / suggested next sequence, editable where
  current behavior allows.

- Required technical files. Observed accepted formats include PDF, DWG,
  DXF, STEP/STP, IGS/IGES, XLS/XLSX, DOC/DOCX, ZIP, JPG/JPEG/PNG;
  observed per-file limit 100 MB.

- Required glass combination selected from the active Glass Catalogue;
  allow adding more than one glass line where supported.

- Optional additional information / notes.

- Draft Save and Submit Order actions.

## 6.3 Profile Order creation

Display a visual catalog derived from the supplied warehouse-order
sheet. Each row has product image, product name/code, unit and a numeric
quantity field. Empty/zero rows are not persisted as order items.

### GASKETS / GARNITURI

| Product                          | Unit  | Customer input |
|----------------------------------|-------|----------------|
| GARNITURA EPDM - GK15            | CUTII | Quantity       |
| GARNITURA EPDM - AD45            | CUTII | Quantity       |
| GARNITURA PT MANA CURENTA - MC12 | CUTII | Quantity       |
| GARNITURA PT MANA CURENTA - MC16 | CUTII | Quantity       |

### PLASTICS / PLASTICE

| Product     | Unit  | Customer input |
|-------------|-------|----------------|
| PANA-115-12 | PUNGI | Quantity       |
| PANA-115-16 | PUNGI | Quantity       |
| PANA-90-12  | PUNGI | Quantity       |
| PANA-90-16  | PUNGI | Quantity       |
| PANA-L115   | PUNGI | Quantity       |
| PANA-L90    | PUNGI | Quantity       |

### ALUMINIUM PROFILES / PROFILE ALUMINIU

| Product       | Unit | Customer input |
|---------------|------|----------------|
| MR23 - 7016   | BARA | Quantity       |
| MR23 - ELX    | BARA | Quantity       |
| RM16 - 7016   | BARA | Quantity       |
| RM16 - ELX    | BARA | Quantity       |
| RM12 - 7016   | BARA | Quantity       |
| RM12 - ELX    | BARA | Quantity       |
| FBL115 - 7016 | BARA | Quantity       |
| FBL115 - ELX  | BARA | Quantity       |
| FBL90 - 7016  | BARA | Quantity       |
| FBL90 - ELX   | BARA | Quantity       |

### ACCESSORIES / ACCESORII

| Product                  | Unit   | Customer input |
|--------------------------|--------|----------------|
| Flansa Perete - ELX      | BUCATI | Quantity       |
| Flansa Perete - 7016     | BUCATI | Quantity       |
| SPIGOTI                  | BUCATI | Quantity       |
| Colt 90-12 (MAI GROS)    | BUCATI | Quantity       |
| Colt 90-16 (MAI SUBTIRE) | BUCATI | Quantity       |
| CAPACE PROFILE - 7016    | BUCATI | Quantity       |
| CAPACE PROFILE - ELX     | BUCATI | Quantity       |

Also provide optional order note, Draft Save and Submit Order. Product
images must be managed in the Admin product catalog, not hard-coded into
the form.

# 7. Glass order workflow

Core workflow. Exact transition names may be normalized internally, but
user-visible behavior must match:

CUSTOMER SUBMITS  
↓  
SALES REVIEW  
├─ reject / hold / request action when permitted  
├─ send to Drawing Team when drawing is required  
└─ direct quote path when drawing is not required  
↓  
DRAWING IN PROGRESS (if required)  
↓  
DRAWING VERSION / APPROVAL / REVISION LOOP  
↓  
SALES PREPARES QUOTE  
↓  
WAITING ADMIN PRICING  
↓  
ADMIN PRICES / REVIEWS  
↓  
ADMIN: SEND TO CUSTOMER  
↓  
CUSTOMER-VISIBLE OFFER / APPROVAL  
↓  
PRODUCTION / LOADING / COMPLETION / ARCHIVE

Critical rule: Sales clicking 'Send to Quote' does NOT send the offer
directly to the customer. It enters the Admin pricing queue. Only Admin
pricing followed by Admin 'Send to Customer' makes the offer visible to
the customer.

# 8. Profile order workflow

CUSTOMER SUBMITS PROFILE ORDER  
↓  
WAITING_ADMIN_PRICING  
↓  
ADMIN REVIEWS QUANTITIES  
↓  
ADMIN ENTERS UNIT PRICES / DISCOUNT / SHIPPING / TAX AS CONFIGURED  
↓  
ADMIN SENDS TO CUSTOMER  
↓  
CUSTOMER SEES PRICED PROFILE OFFER  
↓  
FOLLOW-UP STATUS / ARCHIVE

Profile orders bypass Sales and Drawing. They must not appear in Sales
or Drawing queues. Admin is the only internal role required for initial
profile-order processing.

# 9. Sales portal

- Dashboard queues: new orders / decision pending; SLA risk & overdue;
  waiting for customer approval; production orders.

- Quotes page: waiting for pricing/preparation and sent-to-customer
  history as permitted.

- Loadings calendar/list.

- All Orders, Archive, Help.

- Order detail actions observed include Send to Drawing Team, Reject,
  Send to Quote, Cancel, Hold, subject to current state and permissions.

- Sales prepares the glass quote table but cannot perform the final
  customer send that belongs to Admin.

- Quote exports/communication include PDF, Excel and WhatsApp
  link/message behavior.

# 10. Drawing portal

- Queues: To Draw; Drawings Waiting for Approval; My Drawings;
  customer-supplied DXF/DWG.

- Drawing user can inspect/download customer technical files.

- Upload drawing files (observed PDF/image/DWG/DXF behavior) and create
  a new drawing version.

- Support revision loops and withdrawal where allowed.

- Drawing records are versioned. Never overwrite an old version.

- Notes support customer-visible and internal-only visibility.

- SLA and escalation indicators are visible in the drawing queue.

# 11. Inspector portal

Observed minimal navigation: Quotes, Loadings, Help. Inspector can
inspect closed/order details, customer files, technical drawings, notes
and operational exceptions. Inspector currently sees full company names.
Keep permissions explicit rather than deriving them from Admin/Sales.

# 12. Admin console

- Management Dashboard

- Sales oversight

- Drawing Team oversight

- Quotes

- Important Decisions

- Loadings

- All Orders

- Archive

- Reports

- Users

- Companies/Customers

- Act on Behalf of Customer

- Roles & Permissions

- Team Labels

- Glass Catalogue

- Price Tables

- Settings

- Approval Policies

- SLA & Calendar

- SMTP / Notifications

- Integrations

- Viewer Test

- Moderator Operations

- Audit Log

Add a new Admin module: Profile Product Catalogue. Admin can
create/edit/disable categories and products, upload/change product
images, set unit (BARA/BUCATI/PUNGI/CUTII or future units), display
order and active status.

# 13. Quote and pricing model

## 13.1 Glass quote

Quote lines support customer/project identifiers, glass label, crate
label, delivery date and row-level description/glass combination,
position, width, height, quantity, unit, area, unit price and sales
total as applicable.

## 13.2 Profile quote

Admin pricing view must show requested quantity, unit, unit price and
line total. Support configurable discount, shipping and tax fields.
Store the priced snapshot so later product-catalog edits do not change
historical offers.

### Recommended calculation:

line_total = quantity × unit_price  
subtotal = Σ line_total  
discount_amount = configured discount  
shipping = optional  
tax = configurable  
grand_total = subtotal - discount_amount + shipping + tax

# 14. Product catalog for Profile Orders

Do not hard-code the supplied list into frontend source. Seed it as
initial data and make it editable.

| Field          | Purpose                      |
|----------------|------------------------------|
| id             | Stable UUID/ID               |
| category_id    | Product category             |
| code           | Stable product code          |
| name           | Display name                 |
| image_asset_id | Product visual               |
| unit           | BARA/BUCATI/PUNGI/CUTII/etc. |
| display_order  | Admin-controlled order       |
| active         | Soft enable/disable          |
| metadata       | Future extensibility         |

# 15. Drawings, revisions and approvals

Recommended entities: drawings, drawing_versions, drawing_files,
drawing_approvals, drawing_revision_requests. Each version stores
creator, timestamps, status, files and notes. Approval/revision events
are immutable history entries.

# 16. Notes and conversations

Use structured notes/messages, not one mutable text field. Minimum
visibility values: CUSTOMER_VISIBLE and INTERNAL. Store author role,
author user ID, order ID, optional drawing/quote reference, timestamp
and immutable edit history or append-only behavior where required.

# 17. SLA and escalation engine

SLA is a core domain service. Orders show remaining time or overdue
duration and escalation badges. Admin controls SLA/calendar settings.
Store SLA deadlines explicitly and recalculate only through defined
business rules. Do not derive historical SLA solely from current
configuration.

# 18. Loading / shipment planning

- Calendar and list views.

- Group orders by loading date.

- Per loading day: order count, total square meters, glass count,
  net/gross weight and crate count where applicable.

- Per customer/order/item drill-down.

- Exports observed: total offer summary/Excel, loading list PDF, crate
  labels PDF, daily Excel and WhatsApp actions.

- Keep calculation inputs and generated totals reproducible.

# 19. Notifications

Implement event-driven notifications. Customer settings expose per-event
e-mail subscriptions. Events observed include order received/rejected,
drawing approval/revision events, quote sent/updated, production
start/completion, ready for shipment, SLA/escalation, user/password and
loading-date changes. Use a notification outbox/queue with retry status;
do not send synchronously inside critical database transactions.

# 20. Integrations

- SMTP/e-mail configuration and test send.

- WhatsApp link/message generation; optional webhook automation.

- ERP export hook configurable by endpoint/status.

- Automatic note translation architecture with provider abstraction;
  existing screens reference Google Cloud translation.

- DXF/DWG viewer abstraction; existing system references LibreDWG and
  Autodesk APS options.

- File viewer test page for DWG/DXF/PDF/JPG/PNG.

# 21. Files and storage

Files must be stored outside public web roots or behind authenticated
access. Store original filename, MIME type, size, checksum, uploader,
order relation, visibility, created time and storage key. Authorize
every download/view. Never trust filename extension alone. Scan/validate
uploads as appropriate.

# 22. Audit log

Audit is append-only. Capture login, state transitions, approvals, quote
sends/withdrawals, file views/downloads, admin changes and other
security-sensitive actions. Store actor, role, source entity, action,
timestamp, IP where legally/operationally appropriate, before/after
metadata where safe, and cryptographic checksum references for
approval-sensitive records. UI must not offer edit/delete for audit
rows.

# 23. Suggested data model

users, roles, permissions, user_roles, team_labels, companies,
company_users, order_types, orders, order_status_history,
order_assignments, order_files, order_notes, glass_catalog_items,
glass_order_items, profile_categories, profile_products,
profile_order_items, drawings, drawing_versions, drawing_files,
drawing_approvals, drawing_revision_requests, quotes, quote_versions,
quote_items, price_tables, price_table_items,
salesperson_price_table_assignments, loading_batches,
loading_batch_orders, crates, notifications, notification_preferences,
notification_outbox, sla_policies, approval_policies, system_settings,
integration_settings, audit_logs

Use foreign keys, unique constraints, soft deletion for configurable
catalog data where appropriate, and immutable/versioned records for
commercial and approval history.

# 24. Core order fields

| Field                   | Meaning                              |
|-------------------------|--------------------------------------|
| id                      | UUID/primary key                     |
| order_type_id           | GLASS_ORDER / PROFILE_ORDER / future |
| company_id              | Customer company                     |
| company_sequence        | Company-scoped sequence              |
| order_number            | Rendered internal number             |
| customer_order_number   | Customer-provided/reference number   |
| title                   | Order title                          |
| status                  | Current workflow state               |
| estimated_loading_date  | Planned date                         |
| sla_due_at              | Current SLA deadline                 |
| created_by              | User                                 |
| created_at / updated_at | Timestamps                           |
| archived_at             | Nullable                             |

# 25. State machine implementation

Do not scatter status changes across controllers/components. Implement a
domain transition service:

transitionOrder(orderId, action, actor, payload)  
1. Load order + actor permissions.  
2. Verify action is allowed from current state and order type.  
3. Validate required data/files/quote/drawing.  
4. Execute in DB transaction.  
5. Write new state.  
6. Append order_status_history.  
7. Append audit_log.  
8. Enqueue notifications.  
9. Return sanitized role-specific representation.

# 26. API and security requirements

- Server-side session/authentication with secure cookies or equivalent
  robust mechanism.

- CSRF protection where relevant; rate-limit login and sensitive
  actions.

- RBAC plus resource-level authorization.

- Field-level sanitization/masking for customer identities.

- Never expose integration secrets, SMTP passwords, API keys or storage
  paths to browser clients.

- Validate all numeric quantities and prices server-side.

- Use optimistic locking/version checks for quotes/drawings where
  concurrent editing can occur.

- Audit privileged impersonation / 'Act on behalf of customer'.

- Password reset must use expiring one-time tokens.

# 27. UI specification

Preserve the recognizable current design language: fixed left sidebar,
compact top identity bar, light neutral background, white cards, thin
borders, blue primary actions, pill status labels, compact data tables,
SLA green/red indicators and horizontal workflow progress. Improve
responsiveness and accessibility without changing business semantics.

Customer New Order selector should be visually clearer than the legacy
screens: two large order-type cards with icon/illustration, title and
short explanation. Profile catalog should use category sections and
image-backed rows/cards while remaining fast for large lists.

# 28. Routes / page map

/login  
/customer/orders  
/customer/orders/new  
/customer/orders/new/glass  
/customer/orders/new/profile  
/customer/orders/:id  
/customer/loadings  
/customer/archive  
/customer/settings  
  
/sales  
/sales/quotes  
/sales/loadings  
/sales/orders  
/sales/archive  
/sales/orders/:id  
  
/drawing  
/drawing/orders/:id  
  
/inspector/quotes  
/inspector/loadings  
/inspector/orders/:id  
  
/admin  
/admin/sales  
/admin/drawing  
/admin/quotes  
/admin/decisions  
/admin/loadings  
/admin/orders  
/admin/archive  
/admin/reports  
/admin/users  
/admin/companies  
/admin/impersonation  
/admin/roles  
/admin/team-labels  
/admin/glass-catalog  
/admin/profile-catalog  
/admin/price-tables  
/admin/settings  
/admin/approval-policies  
/admin/sla  
/admin/smtp  
/admin/integrations  
/admin/viewer-test  
/admin/moderation  
/admin/audit

# 29. Recommended implementation phases for Claude Code

### Phase 0 — Repository & architecture

Create project skeleton, environment handling, database migrations, test
framework, linting, seed framework. No business UI yet.

### Phase 1 — Auth / RBAC / Companies

Login, users, companies, roles, permissions, server-side company
masking, admin user/company management.

### Phase 2 — Order core

order_types, orders, numbering, files, notes, status history, audit
service, customer order list/detail.

### Phase 3 — Glass submission

Recreate New Glass Order, glass catalog, file upload, sales review and
queues.

### Phase 4 — Drawing workflow

Assignments, versions, files, approval/revision loop, internal/customer
notes, SLA indicators.

### Phase 5 — Glass quote/admin pricing

Sales quote preparation, admin pricing queue, final Admin Send to
Customer, PDF/Excel hooks.

### Phase 6 — Profile Order module

Order-type selector, profile catalog, visual quantity form, admin-only
pricing workflow, customer-priced offer.

### Phase 7 — Loading/logistics

Calendar, calculations, crates, weights, exports.

### Phase 8 — Notifications/integrations

SMTP, notification preferences/outbox, WhatsApp/webhooks, translation,
viewer adapters, ERP hook.

### Phase 9 — Reports/admin hardening

Reports, approval policies, SLA configuration, moderation, immutable
audit UI.

### Phase 10 — Regression & migration readiness

End-to-end tests for all five roles, security tests, seeded demo data,
backup/restore and deployment docs.

# 30. Acceptance tests that must pass

- Customer can log in and choose Glass or Profile Order.

- Glass Order reproduces the observed submission and workflow behavior.

- Profile Order displays admin-managed product images/items and accepts
  quantities.

- Profile Order never appears in Sales or Drawing work queues.

- Sales cannot send a glass offer directly to the customer; Admin must
  price/approve/send.

- Sales and Drawing APIs never expose full customer company names.

- Admin sees full company names and can price both order types.

- Drawing versions are preserved; revision does not overwrite v1.

- Internal notes are never exposed to customers.

- Every workflow transition creates status history and audit entries.

- Company-scoped order numbers are unique under concurrent creation.

- Customer notification preferences are honored.

- Historical quotes retain their priced snapshot after
  catalog/price-table edits.

- Unauthorized file URLs cannot be opened by another customer/role.

- Loading totals are reproducible from stored order/item data.

# 31. Claude Code operating instruction

You are rebuilding a production business application. Treat this
specification as the source of truth.  
  
Rules:  
1. Work phase by phase. Do not jump ahead.  
2. Before each phase, inspect existing repository code and migrations.  
3. Produce a short implementation plan for the phase.  
4. Implement migrations and domain logic before UI.  
5. Add automated tests for business rules before marking a phase
complete.  
6. Never weaken authorization to make a screen work.  
7. Never expose full customer names to SALES or DRAWING roles.  
8. Never allow SALES to directly send a glass quote to the customer.  
9. PROFILE_ORDER bypasses SALES and DRAWING and goes directly to ADMIN
pricing.  
10. Preserve immutable/versioned commercial, drawing, approval and audit
history.  
11. If this specification is ambiguous, stop and document the ambiguity
rather than inventing a business rule.  
12. Keep order types, profile products, categories, units, SLA rules,
notification events and integrations configurable.  
13. After every phase, provide: changed files, migrations, tests,
remaining risks, and manual verification steps.  
  
Start with Phase 0 only.

# 32. Known ambiguities to keep configurable

- Exact meaning/generation rule of suffixes such as GLA64-1.

- Final Profile Order number formatting (recommended GLAP\<n\>, but
  configurable).

- Post-customer-approval Profile Order fulfillment statuses.

- Exact tax/VAT rules and whether profile pricing should default to
  VAT-inclusive or exclusive.

- Which Inspector actions are writable versus read-only beyond the
  observed screens.

- Exact notification event catalog and localized wording.

- Exact formulas/inputs for all crate and gross-weight calculations.

# 33. Source-derived Profile catalog note

The initial Profile Order seed list is based on the supplied one-page
'Comanda Depozit' sheet dated 25/09/2025. It groups items into
Garnituri, Plastice, Profile Aluminiu and Accesorii, with units such as
CUTII, PUNGI, BARA and BUCATI. Product visuals should be
recreated/uploaded as catalog assets; do not depend on the PDF at
runtime.

**END OF MASTER SPECIFICATION**
