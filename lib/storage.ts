// Dosya saklama: kurallar ve akış server/files/store.js içinde (içerik kontrolü, özet, antivirüs).
export { cleanFileName, removeUpload, resolveKey, storeUpload, uploadRoot } from '../server/files/store.js';

/** Formdan gelen dosya alanlarını ayıklar (boş seçimleri atar). */
export function filesFrom(formData: FormData, field: string): File[] {
  return formData.getAll(field).filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && (f as File).size > 0);
}
