/**
 * Eski düzendeki çizim sürümlerinin (sürüm başına tek dosya, 3.8 ve öncesi) dosyasını DrawingFile'a taşır ve
 * gönderilme zamanını yazar. Tekrar çalıştırılabilir: yalnızca fileUrl'i dolu sürümlere dokunur.
 */
export const drawingFilesStep = {
  name: 'çizim dosyaları (sürüm başına çoklu dosyaya taşıma)',
  available: (db) => typeof db.drawingFile?.create === 'function',
  async run(db) {
    const old = await db.drawing.findMany({ where: { fileUrl: { not: null } } });
    for (const d of old) {
      await db.$transaction([
        db.drawingFile.create({
          data: {
            drawingId: d.id, name: d.fileName || `cizim-v${d.version}`, storageKey: d.fileUrl, size: d.fileSize ?? 0, mime: d.mime,
            checksum: d.checksum, scanStatus: d.scanStatus, scanSignature: d.scanSignature, scannedAt: d.scannedAt,
            uploadedById: d.uploadedById, createdAt: d.createdAt,
          },
        }),
        db.drawing.update({
          where: { id: d.id },
          data: { fileUrl: null, sentAt: d.sentAt ?? (d.status === 'TASLAK' ? null : d.createdAt) },
        }),
      ]);
    }
    return `${old.length} sürüm taşındı`;
  },
};
