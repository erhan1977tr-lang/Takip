import { dayKey } from '../../../server/orders/loading.js';

/**
 * Eski düzendeki sandıkları (sipariş başına, 3.7 ve öncesi) yeni düzene taşır: yükleme günü + müşteri,
 * sandık–sipariş bağlantısı. Sandık numarası o günün boştaki ilk numarasına kaydırılır. Tekrar çalıştırılabilir:
 * yalnızca taşınmamış (orderId dolu) sandıklara dokunur.
 */
export const cratesStep = {
  name: 'sandıklar (yükleme gününe taşıma)',
  available: (db) => typeof db.crateOrder?.create === 'function',
  async run(db) {
    const old = await db.crate.findMany({
      where: { orderId: { not: null } },
      include: { order: { select: { id: true, customerId: true, actualShipDate: true, estimatedShipDate: true } } },
      orderBy: [{ orderId: 'asc' }, { crateNo: 'asc' }],
    });
    let moved = 0;
    for (const c of old) {
      const ship = c.order?.actualShipDate ?? c.order?.estimatedShipDate;
      if (!c.order || !ship) continue;
      const day = dayKey(ship);
      const shipDay = new Date(`${day}T00:00:00Z`);
      await db.$transaction(async (tx) => {
        const used = new Set((await tx.crate.findMany({ where: { shipDay }, select: { crateNo: true } })).map((x) => x.crateNo));
        let no = c.crateNo;
        while (used.has(no)) no++;
        await tx.crate.update({
          where: { id: c.id },
          data: { shipDay, customerId: c.order.customerId, crateNo: no, orderId: null, note: c.dimensions ?? null },
        });
        await tx.crateOrder.create({ data: { crateId: c.id, orderId: c.order.id } });
      });
      moved++;
    }
    return `${moved} sandık taşındı`;
  },
};
