// Müşteri üretim onayı (4.2.1) — saf kurallar: 2 Romanya iş günü (hafta sonu, resmî tatiller, değişken tarihli tatiller,
// yaz / kış saati, tatil verisi olmayan yıl), onay durumu, üretime geçiş koşulu (ayar kapalıyken eski kural aynen),
// müşteri işlemleri, müşterinin gördüğü durum, e-posta ve bildirim metni.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  APPROVAL_BUSINESS_DAYS, APPROVAL_CUTOFF_DEFAULT, approvalCutoff, inApprovalScope, approvalDeadline, approvalDueText, approvalOnSend, approvalOverdue, approvalSettingOn, approvalState, changeNote, localToInstant,
  approvalFlags, approvalReminderAt, loadingApprovalBlock, overrideReason, APPROVAL_RESEND_AFTER_MS,
} from '../server/orders/production-approval.js';
import { approvalOfferId, APPROVAL_REQUEST_TYPES, APPROVAL_REMINDER_TYPE } from '../server/orders/production-approval-delivery.js';
import { NOTIFY_RULES } from '../server/notifications/email.js';
import { can } from '../server/auth/permissions.js';
import { availableActions, customerSummary, productionBlockers, shouldAutoProduce, EVENTS } from '../server/orders/rules.js';
import { STAFF_EVENT_POLICY } from '../server/orders/order-view.js';
import { renderNotification } from '../server/notifications/email.js';
import { INAPP_RULES, renderInApp } from '../server/notifications/inapp.js';
import { ALERT_SECTIONS } from '../server/notifications/order-alerts.js';
import { translate } from '../server/i18n/index.js';
import { enrollCategory } from '../server/orders/production-approval-enroll.js';

const due = (iso) => approvalDeadline(new Date(iso));
const iso = (r) => r.due?.toISOString() ?? null;

test('süre: 2 iş günü, gönderim saati korunur (Europe/Bucharest)', () => {
  assert.equal(APPROVAL_BUSINESS_DAYS, 2);
  // Pazartesi 26.10.2026 10:30 (UTC+2) → Çarşamba 28.10.2026 10:30
  assert.equal(iso(due('2026-10-26T08:30:00Z')), '2026-10-28T08:30:00.000Z');
  // Çarşamba 23:59 → Cuma 23:59
  assert.equal(iso(due('2026-10-28T21:59:00Z')), '2026-10-30T21:59:00.000Z');
  // Cuma → Salı (hafta sonu sayılmaz)
  assert.equal(due('2026-10-30T10:00:00Z').day, '2026-11-03');
  // Cumartesi ve pazar gönderimi: sayım sonraki ilk iş gününden başlar (pazartesi 1, salı 2)
  assert.equal(due('2026-10-31T10:00:00Z').day, '2026-11-03');
  assert.equal(due('2026-11-01T10:00:00Z').day, '2026-11-03');
});

test('süre: Romanya resmî tatilleri sayılmaz (sabit ve değişken tarihli)', () => {
  // 30 Kasım (Sf. Andrei) + 1 Aralık (Ulusal gün): cuma gönderim → çarşamba, perşembe
  assert.equal(due('2026-11-27T10:00:00Z').day, '2026-12-03');
  // 2027 Ortodoks Paskalyası: Kutsal Cuma 30.04, 1 Mayıs (cumartesi), Paskalya 02.05, Paskalya pazartesisi 03.05
  assert.equal(due('2027-04-29T10:00:00Z').day, '2027-05-05');
  // 2027 Pentekost pazartesisi 21.06: cuma 18.06 → salı 22.06 (1), çarşamba 23.06 (2)
  assert.equal(due('2027-06-18T10:00:00Z').day, '2027-06-23');
  // 2026 Paskalya pazartesisi 13.04: cuma 10.04 (Kutsal Cuma — tatil günü gönderim) → salı 14, çarşamba 15
  assert.equal(due('2026-04-10T10:00:00Z').day, '2026-04-15');
  // Yılbaşı: 31.12.2026 perşembe → 01.01 tatil, 02–03.01 hafta sonu → 04.01 (1), 05.01 (2)
  assert.equal(due('2026-12-31T10:00:00Z').day, '2027-01-05');
  // 05.01.2027 salı → 06.01 (Bobotează) ve 07.01 (Sf. Ioan) tatil → 08.01 cuma (1), 11.01 pazartesi (2)
  assert.equal(due('2027-01-05T10:00:00Z').day, '2027-01-11');
});

test('süre: yaz / kış saati geçişinde yerel saat korunur', () => {
  // 27.03.2026 cuma 12:00 (UTC+2) → yaz saati 29.03'te başlar → salı 31.03 12:00 (UTC+3) = 09:00Z
  assert.equal(iso(due('2026-03-27T10:00:00Z')), '2026-03-31T09:00:00.000Z');
  // 23.10.2026 cuma 15:00 (UTC+3) → kış saati 25.10 → salı 27.10 15:00 (UTC+2) = 13:00Z
  assert.equal(iso(due('2026-10-23T12:00:00Z')), '2026-10-27T13:00:00.000Z');
  // Yerel saat → an çevirisi (geçiş günleri dahil) tutarlı
  for (const [day, min] of [['2026-03-29', 600], ['2026-10-25', 600], ['2027-03-28', 0], ['2027-10-31', 1439]]) {
    const at = localToInstant(day, min, 'Europe/Bucharest');
    const back = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    assert.equal(back.replace(',', ''), `${day} ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
  }
});

test('süre: tatil verisi olmayan yıl sessizce hesaplanmaz', () => {
  // 30.12.2027 perşembe → 31.12 (1), 2028'in verisi yok → süre yok
  const r = due('2027-12-30T10:00:00Z');
  assert.deepEqual([r.due, r.noData], [null, true]);
  assert.deepEqual([due('2028-03-01T10:00:00Z').due, due('2028-03-01T10:00:00Z').noData], [null, true]);
  // Geçersiz an
  assert.deepEqual(approvalDeadline('bozuk'), { due: null, noData: false, day: null });
  // 4.2.5: gönderimde süre hiç yazılmaz (iletimde hesaplanır) — veri olmayan yılda da yalnızca talep anı
  const s = approvalOnSend({ productionApprovalRequired: true, status: 'HAZIRLANIYOR' }, new Date('2027-12-30T10:00:00Z'), 'off1');
  assert.deepEqual(s, { data: { approvalRequestedAt: new Date('2027-12-30T10:00:00Z') }, event: { approval: { offerId: 'off1' } } });
});

test('süre: depo takviminin elle kapatılan günleri sayılmaz (yalnızca resmî kural)', () => {
  const src = fs.readFileSync(new URL('../server/orders/production-approval.js', import.meta.url), 'utf8');
  assert.match(src, /dayStatus\(APPROVAL_CALENDAR, day, null\)/, 'yöneticinin kararları geçirilmez');
  assert.doesNotMatch(src, /loadOverrides|calendarOverrides|workCalendarOverride/);
});

test('gönderimde onay: yalnızca bayraklı ve hazırlıktaki sipariş', () => {
  const now = new Date('2026-10-26T08:30:00Z');
  assert.deepEqual(approvalOnSend({ productionApprovalRequired: false, status: 'HAZIRLANIYOR' }, now, 'x'), { data: null, event: null });
  assert.deepEqual(approvalOnSend({ status: 'HAZIRLANIYOR' }, now, 'x'), { data: null, event: null });
  for (const st of ['YENI', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.deepEqual(approvalOnSend({ productionApprovalRequired: true, status: st }, now, 'x'), { data: null, event: null }, st);
  // Üretimdeki siparişte de (kapsam kararı 26.10.2026) yeni sürüm onay ister; talep anı = gönderim anı. Süre gönderimde
  // BAŞLAMAZ (4.2.5): son tarih yok, olay yalnızca sürümün kimliğini taşır
  for (const status of ['HAZIRLANIYOR', 'URETIMDE']) {
    const r = approvalOnSend({ productionApprovalRequired: true, status }, now, 'off1');
    assert.deepEqual(r, { data: { approvalRequestedAt: now }, event: { approval: { offerId: 'off1' } } }, status);
  }
});

test('onay durumu', () => {
  const sent = { status: 'GONDERILDI' };
  assert.equal(approvalState({ required: false, status: 'HAZIRLANIYOR', offer: sent }), 'NONE');
  assert.equal(approvalState({ required: true, status: 'URETIMDE', offer: sent }), 'PENDING', 'üretimdeki sipariş de onay ister');
  for (const st of ['YENI', 'YUKLENDI', 'ARSIVLENDI', 'IPTAL']) assert.equal(approvalState({ required: true, status: st, offer: sent }), 'NONE', st);
  assert.equal(approvalState({ required: true, status: 'HAZIRLANIYOR', offer: null }), 'NONE');
  assert.equal(approvalState({ required: true, status: 'HAZIRLANIYOR', offer: { status: 'HAZIRLANIYOR' } }), 'NONE');
  assert.equal(approvalState({ required: true, status: 'HAZIRLANIYOR', offer: sent }), 'PENDING');
  assert.equal(approvalState({ required: true, status: 'HAZIRLANIYOR', offer: { ...sent, approvedAt: new Date() } }), 'APPROVED');
  assert.equal(approvalState({ required: true, status: 'HAZIRLANIYOR', offer: { ...sent, changeRequestedAt: new Date() } }), 'CHANGE_REQUESTED');
  assert.equal(approvalOverdue({ approvalDueAt: '2026-10-28T08:30:00Z' }, new Date('2026-10-28T08:29:59Z')), false);
  assert.equal(approvalOverdue({ approvalDueAt: '2026-10-28T08:30:00Z' }, new Date('2026-10-28T08:30:00Z')), true);
  assert.equal(approvalOverdue({ approvalDueAt: null }, new Date()), false);
  assert.equal(approvalSettingOn({ enabled: true }), true);
  for (const v of [null, undefined, {}, { enabled: 'true' }, [true], 'on']) assert.equal(approvalSettingOn(v), false);
});

test('üretime geçiş: onay verilmezse (NONE) eski kural aynen; bekleyen onay üretimi engeller', () => {
  const base = { status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'GONDERILDI' };
  assert.deepEqual(productionBlockers(base), []);
  assert.equal(shouldAutoProduce(base), true);
  assert.deepEqual(productionBlockers({ ...base, approval: 'NONE' }), []);
  assert.deepEqual(productionBlockers({ ...base, approval: 'APPROVED' }), []);
  assert.deepEqual(productionBlockers({ ...base, approval: 'PENDING' }), ['offer_not_approved']);
  assert.deepEqual(productionBlockers({ ...base, approval: 'CHANGE_REQUESTED' }), ['offer_not_approved']);
  assert.equal(shouldAutoProduce({ ...base, approval: 'PENDING' }), false);
  // Onay alındı ama çizim bitmedi: çizim koşulu yine geçerli
  assert.deepEqual(productionBlockers({ ...base, drawing: 'YAPILIYOR', approval: 'APPROVED' }), ['drawing_not_done']);
  assert.equal(shouldAutoProduce({ ...base, onHold: true, approval: 'APPROVED' }), false);
  // Teklif müşteride değilse onay koşulu eklenmez (eski kod)
  assert.deepEqual(productionBlockers({ ...base, offer: 'YONETIMDE', approval: 'PENDING' }), ['offer_at_admin']);
});

test('müşteri işlemleri: onay yetkisi + bekleyen onay; diğer rollerde yok', () => {
  const p = { status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'GONDERILDI', orderType: 'GLASS_ORDER' };
  const cust = (extra) => availableActions({ role: 'MUSTERI', canApprove: true, ...p, ...extra });
  assert.ok(cust({ approval: 'PENDING' }).includes('approve_production'));
  assert.ok(cust({ approval: 'PENDING' }).includes('request_offer_change'));
  for (const a of ['NONE', 'APPROVED', 'CHANGE_REQUESTED']) assert.equal(cust({ approval: a }).includes('approve_production'), false, a);
  assert.equal(cust({}).includes('approve_production'), false, 'verilmezse eski davranış');
  assert.equal(availableActions({ role: 'MUSTERI', canApprove: false, ...p, approval: 'PENDING' }).includes('approve_production'), false);
  assert.equal(cust({ approval: 'PENDING', status: 'URETIMDE' }).includes('approve_production'), true, 'üretimdeki siparişte de');
  assert.equal(cust({ approval: 'PENDING', status: 'YUKLENDI' }).includes('approve_production'), false);
  assert.equal(cust({ approval: 'PENDING', orderType: 'PROFILE_ORDER' }).includes('approve_production'), false);
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'DENETIMCI']) {
    const a = availableActions({ role, canApprove: true, ...p, approval: 'PENDING' });
    assert.equal(a.includes('approve_production') || a.includes('request_offer_change'), false, role);
  }
  // Bekleyen onay satışın / yöneticinin eski işlemlerini değiştirmez
  const admin = availableActions({ role: 'ADMIN', ...p, approval: 'PENDING' });
  assert.deepEqual(admin, availableActions({ role: 'ADMIN', ...p }));
  const sales = availableActions({ role: 'SATIS', ...p, approval: 'PENDING' });
  assert.deepEqual(sales, availableActions({ role: 'SATIS', ...p }));
});

test('müşterinin gördüğü durum: "Üretim onayı gereklidir"', () => {
  const p = { status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'GONDERILDI' };
  assert.equal(customerSummary(p).key, 'offerReady', 'eski davranış');
  assert.equal(customerSummary({ ...p, approval: 'PENDING' }).key, 'productionApproval');
  assert.equal(customerSummary({ ...p, approval: 'CHANGE_REQUESTED' }).key, 'changeRequested');
  assert.equal(customerSummary({ ...p, approval: 'APPROVED' }).key, 'productionApproved');
  assert.equal(customerSummary({ ...p, status: 'URETIMDE', approval: 'PENDING' }).key, 'productionApproval');
  assert.equal(customerSummary({ ...p, status: 'URETIMDE', approval: 'CHANGE_REQUESTED' }).key, 'changeRequested');
  assert.equal(customerSummary({ ...p, status: 'URETIMDE', approval: 'APPROVED' }).key, 'production');
  assert.equal(customerSummary({ ...p, status: 'URETIMDE' }).key, 'production', 'eski davranış');
  // Çizim onayı önce gelir
  assert.equal(customerSummary({ ...p, drawing: 'ONAY_BEKLIYOR', approval: 'PENDING' }).key, 'awaitingApproval');
  assert.equal(translate('tr', 'status.customer.productionApproval.label'), 'Üretim onayı gereklidir');
  assert.equal(translate('tr', 'notifications.productionApproval.customer'), 'Üretim onayınız bekleniyor');
  assert.equal(translate('tr', 'order.approval.listBadge'), 'Onay gerekli');
  assert.equal(translate('tr', 'order.approval.approve'), 'ÜRETİME ALINMASINI ONAYLIYORUM');
  assert.equal(translate('tr', 'order.approval.change'), 'ÖLÇÜLERDE DEĞİŞİKLİK VAR');
  for (const l of ['tr', 'ro']) assert.notEqual(translate(l, 'status.blockers.offer_not_approved'), 'status.blockers.offer_not_approved');
});

test('değişiklik notu: zorunlu, en fazla 2000 karakter', () => {
  assert.deepEqual(changeNote(''), { ok: false, code: 'CHANGE_NOTE_REQUIRED' });
  assert.deepEqual(changeNote('   \n '), { ok: false, code: 'CHANGE_NOTE_REQUIRED' });
  assert.deepEqual(changeNote(null), { ok: false, code: 'CHANGE_NOTE_REQUIRED' });
  assert.deepEqual(changeNote('x'.repeat(2001)), { ok: false, code: 'CHANGE_NOTE_TOO_LONG' });
  assert.deepEqual(changeNote(' 2. satır 1200×800 olmalı\r\n'), { ok: true, note: '2. satır 1200×800 olmalı' });
});

test('olaylar: müşteri geçmişinde görünür, iç ekip politikası tanımlı, bildirim bölümü var', () => {
  assert.deepEqual(EVENTS.PRODUCTION_APPROVED, { customer: true });
  assert.deepEqual(EVENTS.OFFER_CHANGE_REQUESTED, { customer: true, note: true });
  assert.ok(STAFF_EVENT_POLICY.PRODUCTION_APPROVED && STAFF_EVENT_POLICY.OFFER_CHANGE_REQUESTED);
  assert.deepEqual(INAPP_RULES.ORDER_PRODUCTION_APPROVED.to(), ['admin', 'orderSales']);
  assert.deepEqual(INAPP_RULES.ORDER_OFFER_CHANGE_REQUESTED.to(), ['admin', 'orderSales']);
  for (const type of ['ORDER_PRODUCTION_APPROVED', 'ORDER_OFFER_CHANGE_REQUESTED']) assert.ok(ALERT_SECTIONS.teklif.includes(type), type);
  for (const l of ['tr', 'ro']) {
    for (const k of ['events.PRODUCTION_APPROVED.label', 'events.PRODUCTION_APPROVED.customer', 'events.OFFER_CHANGE_REQUESTED.label', 'events.OFFER_CHANGE_REQUESTED.customer', 'notifications.types.PRODUCTION_APPROVAL_OVERDUE.title']) {
      assert.notEqual(translate(l, k), k, `${l} ${k}`);
    }
  }
});

test('son tarih metni Romanya saatiyle', () => {
  assert.equal(approvalDueText('2026-10-28T08:30:00.000Z'), '28.10.2026 10:30');
  assert.equal(approvalDueText(new Date('2026-07-01T21:05:00Z')), '02.07.2026 00:05');
  assert.equal(approvalDueText(null), null);
  assert.equal(approvalDueText('bozuk'), null);
});

test('e-posta: müşterinin dilinde zorunlu onay metni ve kesin son tarih; iç ekibe / onaysız gönderime eklenmez', () => {
  const order = { id: 'o1', orderNo: 'GLA68', customer: { name: 'Glass and More' } };
  const base = { order, createdAt: new Date('2026-10-26T08:30:00Z'), appUrl: 'https://t', timeZone: 'Europe/Bucharest' };
  const payload = { approval: { due: '2026-10-28T08:30:00.000Z' } };
  const ro = renderNotification({ ...base, type: 'ORDER_OFFER_SENT', recipient: { locale: 'ro', role: null }, payload });
  assert.match(ro.text, /Termen de aprobare: 28\.10\.2026 10:30 \(ora României\)/);
  assert.match(ro.text, /dimensiunile, cantitățile și prețurile/);
  assert.match(ro.text, /obligatorie/);
  assert.match(ro.text, /2 zile lucrătoare/);
  assert.match(ro.text, /data de încărcare/);
  assert.match(ro.html, /28\.10\.2026 10:30/);
  const tr = renderNotification({ ...base, type: 'ORDER_OFFER_UPDATED', recipient: { locale: 'tr', role: null }, payload });
  assert.match(tr.text, /Son onay tarihi: 28\.10\.2026 10:30 \(Romanya saati\)/);
  assert.match(tr.text, /2 Romanya iş günüdür/);
  assert.match(tr.text, /iletilmesinden itibaren/, 'süre bildirimin iletildiği andan');
  const none = renderNotification({ ...base, type: 'ORDER_OFFER_SENT', recipient: { locale: 'ro', role: null }, payload: { approval: { due: null } } });
  assert.match(none.text, /Nu a putut fi stabilit/);
  const plain = renderNotification({ ...base, type: 'ORDER_OFFER_SENT', recipient: { locale: 'ro', role: null }, payload: {} });
  assert.doesNotMatch(plain.text, /Termen de aprobare/);
  const staff = renderNotification({ ...base, type: 'ORDER_OFFER_SENT', recipient: { locale: 'tr', role: 'SATIS' }, payload });
  assert.doesNotMatch(staff.text, /Son onay tarihi/);
});

test('uygulama içi bildirim: müşteriye "Üretim onayınız bekleniyor" + son tarih', () => {
  const r = renderInApp('ro', { type: 'ORDER_OFFER_SENT', params: { aud: 'customer', orderNo: 'GLA68', approval: 1, due: '28.10.2026 10:30' } });
  assert.equal(r.title, 'Se așteaptă aprobarea dvs. pentru producție');
  assert.match(r.body, /GLA68/);
  assert.match(r.body, /28\.10\.2026 10:30/);
  const tr = renderInApp('tr', { type: 'ORDER_OFFER_SENT', params: { aud: 'customer', orderNo: 'GLA68', approval: 1, due: '' } });
  assert.match(tr.body, /belirlenemedi/);
  // Onay bilgisi yoksa eski metin
  assert.equal(renderInApp('tr', { type: 'ORDER_OFFER_SENT', params: { aud: 'customer', orderNo: 'GLA68' } }).title, translate('tr', 'events.OFFER_SENT.customer'));
  const over = renderInApp('tr', { type: 'PRODUCTION_APPROVAL_OVERDUE', params: { aud: 'staff', orderNo: 'GLA68', day: '2026-10-28' } });
  assert.match(over.title, /Üretim onayı gecikti/);
  assert.match(over.body, /28\.10\.2026/);
});

test('yapı: onay yalnızca iş akışı servisinden yazılır; proforma / muhasebe / FGO / yükleme modülleri onaya bakmaz', () => {
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const writers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs|ts|tsx)$/.test(e.name)) continue;
      if (/data: \{ approvedAt: now, approvedById: actor\.id \}|changeRequestedAt: now|approvalOverdueAt: now/.test(read(p))) writers.push(p);
    }
  };
  for (const d of ['server', 'app', 'lib', 'scripts']) walk(d);
  assert.deepEqual(writers.sort(), ['server/orders/production-approval-service.js', 'server/orders/transitions.js']);
  for (const p of ['server/glass/billing.js', 'server/glass/batch.js', 'server/glass/invoice-batch.js', 'server/orders/financial-lock.js', 'server/integrations/fgo.js', 'server/loading/crates.js', 'server/loading/confirmation.js', 'server/accounting/receivables.js']) {
    assert.doesNotMatch(read(p), /production-approval|approvalState|approvedAt|productionApprovalRequired/, p);
  }
  // Yükleme onayı yalnızca ortak engeli çağırır (4.2.5): kural tek yerde (loading-approval.js → loadingApprovalBlock)
  assert.match(read('server/loading/confirmation.js'), /const blocked = await loadingApprovalBlocks\(tx, \{ orderIds: base\.orders\.map\(\(o\) => o\.orderId\) \}\);\s+if \(blocked\.length\) return \{ ok: false, code: 'APPROVAL_REQUIRED', blocked \};/);
});

test('kapsam: planlanan yükleme günü ≥ kesim günü (varsayılan 06.11.2026)', () => {
  assert.equal(APPROVAL_CUTOFF_DEFAULT, '2026-11-06');
  assert.equal(approvalCutoff(null), '2026-11-06');
  assert.equal(approvalCutoff({ enabled: true, cutoff: '2026-12-01' }), '2026-12-01');
  for (const bad of ['2026-13-01', '06.11.2026', '', 5, null]) assert.equal(approvalCutoff({ cutoff: bad }), '2026-11-06', String(bad));
  assert.equal(inApprovalScope('2026-11-06', '2026-11-06'), true);
  assert.equal(inApprovalScope('2027-01-02', '2026-11-06'), true);
  assert.equal(inApprovalScope('2026-11-05', '2026-11-06'), false);
  assert.equal(inApprovalScope(null, '2026-11-06'), false);
});

test('geçiş kategorisi: yüklenmiş / faturalı / telafi asla yazılmaz; güncel teklif müşterideyse talep', () => {
  const sent = { status: 'GONDERILDI' };
  const f = { loaded: false, finalInvoiced: false };
  assert.equal(enrollCategory({ status: 'HAZIRLANIYOR', offers: [sent] }, f), 'REQUEST');
  assert.equal(enrollCategory({ status: 'URETIMDE', offers: [sent] }, f), 'REQUEST');
  assert.equal(enrollCategory({ status: 'URETIMDE', offers: [sent] }, { ...f, loaded: true }), 'LOADED', 'kısmi yükleme dahil');
  assert.equal(enrollCategory({ status: 'YUKLENDI', offers: [sent] }, f), 'LOADED');
  assert.equal(enrollCategory({ status: 'URETIMDE', offers: [sent] }, { ...f, finalInvoiced: true }), 'FINAL_INVOICED');
  assert.equal(enrollCategory({ status: 'URETIMDE', compOfId: 'x', offers: [sent] }, f), 'COMPENSATION');
  assert.equal(enrollCategory({ status: 'URETIMDE', offers: [] }, f), 'NO_OFFER');
  // Güncel teklif henüz müşteride değil (yeni sürüm hazırlanıyor): kapsam işareti — onay yeni sürüm gönderilince (27.10.2026)
  assert.equal(enrollCategory({ status: 'HAZIRLANIYOR', offers: [{ status: 'HAZIRLANIYOR' }, sent] }, f), 'FLAG_ONLY');
  assert.equal(enrollCategory({ status: 'HAZIRLANIYOR', offers: [{ status: 'YONETIMDE' }] }, f), 'FLAG_ONLY');
  assert.equal(enrollCategory({ status: 'YENI', offers: [] }, f), 'FLAG_ONLY');
  assert.equal(enrollCategory({ status: 'YENI', productionApprovalRequired: true, offers: [] }, f), 'ALREADY');
  assert.equal(enrollCategory({ status: 'URETIMDE', productionApprovalRequired: true, offers: [{ ...sent, approvalRequestedAt: new Date() }] }, f), 'ALREADY', 'ikinci talep yok');
  assert.equal(enrollCategory({ status: 'URETIMDE', productionApprovalRequired: true, offers: [{ ...sent, approvedAt: new Date() }] }, f), 'ALREADY');
});

test('geçiş: HTTP yolu yok — yalnızca sunucu betiği çağırır', () => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (/\.(js|mjs|ts|tsx)$/.test(e.name) && fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').match(/from\s+['"][^'"]*production-approval-enroll/)) hits.push(p);
    }
  };
  for (const d of ['app', 'lib', 'components', 'server', 'scripts']) walk(d);
  assert.deepEqual(hits.sort(), ['scripts/production-approval-enroll.mjs']);
});

// ---------- 4.2.5: teslime bağlı süre, hatırlatma, onaysız yükleme engeli, yönetici istisnası ----------

test('hatırlatma: iletimden 1 Romanya iş günü sonra (aynı yerel saat)', () => {
  // Pazartesi 09.11.2026 10:30 → salı 10.11 10:30
  assert.equal(approvalReminderAt(new Date('2026-11-09T08:30:00Z')).due.toISOString(), '2026-11-10T08:30:00.000Z');
  // Cuma → pazartesi; 30.11 / 01.12 tatil → 02.12
  assert.equal(approvalReminderAt(new Date('2026-11-06T09:00:00Z')).day, '2026-11-09');
  assert.equal(approvalReminderAt(new Date('2026-11-27T09:00:00Z')).day, '2026-12-02');
  assert.equal(approvalReminderAt(new Date('2027-12-31T09:00:00Z')).due, null, 'veri yoksa tahmin edilmez');
});

test('yükleme engeli: kapsam bayrağa bağlı (tarih değişikliği engeli kaldırmaz); 30.10.2026 bayraksız; gönderilmiş son sürüm', () => {
  const order = { productionApprovalRequired: true, loadingOverrideAt: null };
  const pending = { status: 'GONDERILDI', approvedAt: null, changeRequestedAt: null };
  // 2. kapsamdaki sipariş onaysız yüklenemez — gün bilgisi kurala hiç girmez (5. tarih değiştirerek aşılamaz)
  assert.equal(loadingApprovalBlock({ enabled: true, order, offer: pending }), 'PENDING');
  assert.equal(loadingApprovalBlock({ enabled: true, day: '2026-10-30', cutoff: '2026-11-06', order, offer: pending }), 'PENDING', 'gün kurala girmez');
  assert.equal(loadingApprovalBlock({ enabled: true, order, offer: { ...pending, changeRequestedAt: new Date() } }), 'CHANGE_REQUESTED');
  assert.equal(loadingApprovalBlock({ enabled: true, order, offer: null }), 'NOT_SENT', 'müşteriye gönderilmiş sürüm yok');
  // 1. 30.10.2026 siparişleri bayraksızdır → engel yok
  assert.equal(loadingApprovalBlock({ enabled: true, order: { productionApprovalRequired: false }, offer: pending }), null);
  // Onaylı son gönderilmiş sürüm → serbest
  assert.equal(loadingApprovalBlock({ enabled: true, order, offer: { ...pending, approvedAt: new Date() } }), null);
  // 6. Yönetici istisnası → serbest (müşteri onayı yerine geçmez: kural teklif alanlarına yazmaz)
  assert.equal(loadingApprovalBlock({ enabled: true, order: { ...order, loadingOverrideAt: new Date() }, offer: pending }), null);
  // 8. Ayar kapalı → 4.2.0 davranışı
  assert.equal(loadingApprovalBlock({ enabled: false, order, offer: pending }), null);
  const src = fs.readFileSync(new URL('../server/orders/loading-approval.js', import.meta.url), 'utf8');
  assert.match(src, /offers: \{ where: \{ status: 'GONDERILDI' \}, orderBy: \{ createdAt: 'desc' \}, take: 1/, '11. gönderilmemiş taslak onayı bozmaz');
});

test('acil durdurma anahtarı: kapalıyken onay durumu yok, yeni talep açılmaz, istisna / yeniden gönderim yok', () => {
  const sent = { status: 'GONDERILDI' };
  for (const status of ['HAZIRLANIYOR', 'URETIMDE']) {
    assert.equal(approvalState({ required: true, status, offer: sent, enabled: false }), 'NONE', status);
    assert.equal(approvalState({ required: true, status, offer: sent, enabled: true }), 'PENDING', status);
  }
  const base = { status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'GONDERILDI' };
  assert.equal(shouldAutoProduce({ ...base, approval: approvalState({ required: true, status: 'HAZIRLANIYOR', offer: sent, enabled: false }) }), true, '4.2.0: teklif müşterideyse üretime geçer');
  assert.deepEqual(approvalOnSend({ productionApprovalRequired: true, status: 'HAZIRLANIYOR', approvalEnabled: false }, new Date(), 'x'), { data: null, event: null });
  const o = { productionApprovalRequired: true, status: 'URETIMDE', loadingOverrideAt: null, offers: [{ status: 'GONDERILDI', approvalRequestedAt: new Date(0) }] };
  assert.deepEqual(approvalFlags({ ...o, approvalEnabled: false }), { loadingOverride: false, approvalResend: false });
  assert.deepEqual(approvalFlags(o), { loadingOverride: true, approvalResend: true });
  // Özellik kapalıyken gönderilmiş sürüm (talep kaydı yok): yeniden açılınca yönetici talebi gönderebilir — kendiliğinden yazılmaz
  assert.equal(approvalFlags({ ...o, offers: [{ status: 'GONDERILDI' }] }).approvalResend, true);
  // Müşteri işlemleri NONE durumunda yok
  const acts = availableActions({ role: 'MUSTERI', canApprove: true, status: 'HAZIRLANIYOR', drawing: 'YOK', offer: 'GONDERILDI', orderType: 'GLASS_ORDER', approval: 'NONE' });
  assert.equal(acts.includes('approve_production'), false);
});

test('taslak onayı bozmaz: onaylı gönderilmiş sürümden sonra taslak varken yükleme istisnası gerekmez', () => {
  const approved = { status: 'GONDERILDI', approvedAt: new Date('2026-11-01T10:00:00Z') };
  const o = { productionApprovalRequired: true, status: 'HAZIRLANIYOR', loadingOverrideAt: null, offers: [{ status: 'HAZIRLANIYOR' }, approved] };
  assert.equal(approvalFlags(o).loadingOverride, false);
  assert.equal(loadingApprovalBlock({ enabled: true, order: o, offer: approved }), null);
});

test('istisna ve yeniden gönderim: yalnızca yönetici istisna verir; gerekçe zorunlu', () => {
  // 4. Yönetici dışındaki roller istisna veremez (yardımcı dahil — ADMIN_ONLY)
  for (const r of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) assert.equal(can(r, 'LOADING_APPROVAL_OVERRIDE'), r === 'ADMIN', r);
  const p = { status: 'URETIMDE', drawing: 'YOK', offer: 'GONDERILDI', orderType: 'GLASS_ORDER', loadingOverride: true };
  for (const role of ['ADMIN', 'YONETICI_YARDIMCISI', 'SATIS', 'CIZIM', 'MUSTERI', 'DENETIMCI']) {
    assert.equal(availableActions({ role, canApprove: true, ...p }).includes('override_loading_approval'), role === 'ADMIN', role);
  }
  assert.equal(availableActions({ role: 'ADMIN', ...p, loadingOverride: false }).includes('override_loading_approval'), false);
  assert.equal(availableActions({ role: 'ADMIN', ...p, status: 'ARSIVLENDI' }).includes('override_loading_approval'), false);
  assert.equal(availableActions({ role: 'ADMIN', ...p, approvalResend: true }).includes('resend_approval_request'), true);
  assert.equal(availableActions({ role: 'YONETICI_YARDIMCISI', ...p, approvalResend: true }).includes('resend_approval_request'), true);
  assert.equal(availableActions({ role: 'SATIS', ...p, approvalResend: true }).includes('resend_approval_request'), false);
  assert.deepEqual(overrideReason(''), { ok: false, code: 'OVERRIDE_REASON_REQUIRED' });
  assert.deepEqual(overrideReason('  \n '), { ok: false, code: 'OVERRIDE_REASON_REQUIRED' });
  assert.deepEqual(overrideReason('x'.repeat(1001)), { ok: false, code: 'OVERRIDE_REASON_TOO_LONG' });
  assert.deepEqual(overrideReason(' Müşteri\n telefonla onay verdi '), { ok: true, reason: 'Müşteri telefonla onay verdi' });
});

test('bayraklar: istisna ve yeniden gönderim ne zaman açılır', () => {
  const now = new Date('2026-11-09T12:00:00Z');
  const o = (offer, extra = {}) => ({ productionApprovalRequired: true, status: 'URETIMDE', loadingOverrideAt: null, offers: [offer], ...extra });
  const pending = { status: 'GONDERILDI', approvalRequestedAt: new Date('2026-11-09T11:30:00Z') };
  assert.deepEqual(approvalFlags(o(pending), now), { loadingOverride: true, approvalResend: false }, 'kuyruk hâlâ deniyor olabilir');
  assert.equal(approvalFlags(o({ ...pending, approvalDeliveryError: 'EMAIL_FAILED' }), now).approvalResend, true);
  assert.equal(approvalFlags(o({ ...pending, approvalRequestedAt: new Date(now.getTime() - APPROVAL_RESEND_AFTER_MS) }), now).approvalResend, true, 'bir saatten eski iletilmemiş talep');
  assert.equal(approvalFlags(o({ ...pending, approvalDeliveryError: 'EMAIL_FAILED', approvalDeliveredAt: now }), now).approvalResend, false, 'iletilmiş');
  assert.deepEqual(approvalFlags(o({ ...pending, approvedAt: now }), now), { loadingOverride: false, approvalResend: false }, 'onaylı');
  assert.equal(approvalFlags(o(pending, { loadingOverrideAt: now }), now).loadingOverride, false, 'istisna bir kez');
  assert.deepEqual(approvalFlags(o(pending, { productionApprovalRequired: false }), now), { loadingOverride: false, approvalResend: false });
  assert.deepEqual(approvalFlags(o(pending, { status: 'YUKLENDI' }), now), { loadingOverride: false, approvalResend: false });
});

test('iletim: onay taşıyan olaylar, sürüm kimliği doğrulanır; hatırlatma müşteriye e-posta + zil', () => {
  assert.deepEqual([...APPROVAL_REQUEST_TYPES].sort(), ['ORDER_OFFER_SENT', 'ORDER_OFFER_UPDATED', 'ORDER_PRODUCTION_APPROVAL_REQUESTED']);
  assert.equal(approvalOfferId('ORDER_OFFER_SENT', { approval: { offerId: 'clxyz12345abc' } }), 'clxyz12345abc');
  assert.equal(approvalOfferId(APPROVAL_REMINDER_TYPE, { approval: { offerId: 'clxyz12345abc' } }), 'clxyz12345abc');
  assert.equal(approvalOfferId('ORDER_SHIP_DATE', { approval: { offerId: 'clxyz12345abc' } }), null);
  for (const bad of [null, {}, { approval: null }, { approval: { offerId: '../x' } }, { approval: { offerId: 5 } }, { approval: { due: 'x' } }]) assert.equal(approvalOfferId('ORDER_OFFER_SENT', bad), null);
  assert.deepEqual(NOTIFY_RULES.ORDER_PRODUCTION_APPROVAL_REMINDER({}), ['customer']);
  assert.deepEqual(INAPP_RULES.ORDER_PRODUCTION_APPROVAL_REMINDER.to(), ['customer']);
  assert.ok(ALERT_SECTIONS.teklif.includes('ORDER_PRODUCTION_APPROVAL_REMINDER'));
  assert.deepEqual(EVENTS.PRODUCTION_APPROVAL_REMINDER, { customer: true });
  assert.deepEqual(EVENTS.LOADING_APPROVAL_OVERRIDE, { customer: false, note: true }, 'istisna müşteriye görünmez');
  for (const l of ['tr', 'ro']) {
    for (const k of ['events.PRODUCTION_APPROVAL_REMINDER.customer', 'events.LOADING_APPROVAL_OVERRIDE.label', 'notifications.productionApproval.reminder', 'notifications.types.PRODUCTION_APPROVAL_UNDELIVERED.title', 'loading.confirm.errors.APPROVAL_REQUIRED', 'order.errors.loadingApprovalRequired']) {
      assert.notEqual(translate(l, k), k, `${l} ${k}`);
    }
  }
  // Talep bildirimi son tarih taşımaz (süre iletimde başlar); hatırlatma saklanan son tarihi yazar
  const req = renderInApp('tr', { type: 'ORDER_PRODUCTION_APPROVAL_REQUESTED', params: { aud: 'customer', orderNo: 'GLA68', approval: 1 } });
  assert.equal(req.title, 'Üretim onayınız bekleniyor');
  assert.doesNotMatch(req.body, /son onay|belirlenemedi/);
  const rem = renderInApp('ro', { type: APPROVAL_REMINDER_TYPE, params: { aud: 'customer', orderNo: 'GLA68', approval: 1, due: '11.11.2026 10:30' } });
  assert.match(rem.title, /Memento/);
  assert.match(rem.body, /11\.11\.2026 10:30/);
  const order = { id: 'o1', orderNo: 'GLA68', customer: { name: 'Glass and More' } };
  const mail = renderNotification({ order, createdAt: new Date('2026-11-10T08:30:00Z'), appUrl: 'https://t', timeZone: 'Europe/Bucharest', type: APPROVAL_REMINDER_TYPE, recipient: { locale: 'tr', role: null }, payload: { approval: { offerId: 'x', due: '2026-11-11T08:30:00.000Z' } } });
  assert.match(mail.subject, /Hatırlatma/);
  assert.match(mail.text, /Son onay tarihi: 11\.11\.2026 10:30/);
});
