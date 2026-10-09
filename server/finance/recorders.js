// Belirsiz sonuçlu FGO işinin yönetici tarafından doğrulanan belgesini kaydeden yollar (karar 209): her hedef, işçinin KENDİ
// başarı yolunu kullanır (ikinci bir kayıt yolu yazılmaz). server/finance/uncertain.js → resolveUncertainJob({ recorders }).
// Ayrı dosyadadır: uncertain.js işçiler tarafından içe aktarılır, işçilere geri bağımlı olmasın (döngü yok).
import { recordGlassIssued } from '../glass/billing.js';
import { recordBatchIssued } from '../glass/batch.js';
import { recordProfileAdvance, recordProfileIssued } from '../profile/fgo-jobs.js';

const prepOf = (job) => job.payload?.uncertain?.prepared ?? {};

export const UNCERTAIN_RECORDERS = Object.freeze({
  GLASS: (db, job, doc, now) => recordGlassIssued(db, { orderId: job.orderId, rowId: job.id, prepared: prepOf(job), doc, now }),
  PROFILE: (db, job, doc) => recordProfileIssued(db, { orderId: job.orderId, rowId: job.id, prepared: prepOf(job), doc }),
  PROFILE_ADVANCE: (db, job, doc, now) => recordProfileAdvance(db, { orderId: job.orderId, rowId: job.id, prepared: prepOf(job), doc, now }),
  BATCH: (db, job, doc, now) => recordBatchIssued(db, { batchId: String(job.payload?.batchId ?? ''), rowId: job.id, doc, now }),
});
