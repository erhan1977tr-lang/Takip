// Denetim kaydı girdisi (ADR 0005). Kayıtlar yalnızca eklenir; veritabanı tetikleyicisi güncelleme/silmeyi engeller.

/**
 * @param {{ action: string, entityType: string, entityId?: string | null, actor?: { id: string, role: string } | null, details?: object }} e
 */
export function auditEntry({ action, entityType, entityId = null, actor = null, details = {} }) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(action)) throw new Error(`denetim eylemi BÜYÜK_HARF olmalı: ${action}`);
  if (!entityType) throw new Error('entityType gerekli');
  return {
    action,
    entityType,
    entityId,
    userId: actor?.id ?? null,
    details: { ...details, ...(actor ? { role: actor.role } : {}) },
  };
}
