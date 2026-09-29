// Saf iş akışı tanımı (ADR 0002). Veritabanına dokunmaz; bir eylemin, verilen durumda ve rolde
// geçerli olup olmadığını söyler. Her sipariş tipi kendi akışını defineWorkflow ile tanımlar.
//
// Eylem: { from: [durumlar], to: durum | null (durum değişmez), roles: [roller], guard?(ctx) → hata kodu | null }

export class WorkflowError extends Error {
  /** @param {string} code  makine kodu; ekranda i18n ile çevrilir */
  constructor(code, details = {}) {
    super(code);
    this.name = 'WorkflowError';
    this.code = code;
    this.details = details;
  }
}

export function defineWorkflow({ orderType, states, actions }) {
  if (!orderType) throw new Error('orderType gerekli');
  const stateSet = new Set(states);
  for (const [name, a] of Object.entries(actions)) {
    if (!Array.isArray(a.from) || !a.from.length) throw new Error(`${orderType}.${name}: from boş`);
    for (const s of a.from) if (!stateSet.has(s)) throw new Error(`${orderType}.${name}: bilinmeyen durum ${s}`);
    if (a.to !== null && !stateSet.has(a.to)) throw new Error(`${orderType}.${name}: bilinmeyen hedef ${a.to}`);
    if (!Array.isArray(a.roles) || !a.roles.length) throw new Error(`${orderType}.${name}: roles boş`);
  }

  /**
   * @returns {{ ok: true, to: string | null } | { ok: false, code: string }}
   */
  function check({ state, orderType: type, action, actor, ctx = {} }) {
    const a = actions[action];
    if (!a) return { ok: false, code: 'UNKNOWN_ACTION' };
    if (type !== orderType) return { ok: false, code: 'WRONG_ORDER_TYPE' };
    if (!a.roles.includes(actor?.role)) return { ok: false, code: 'FORBIDDEN_ROLE' };
    if (!a.from.includes(state)) return { ok: false, code: 'INVALID_STATE' };
    const guardCode = a.guard ? a.guard({ ...ctx, state, actor }) : null;
    if (guardCode) return { ok: false, code: guardCode };
    return { ok: true, to: a.to };
  }

  /** Bu kullanıcının bu durumda yapabileceği eylemler (ekranda düğme göstermek için; yetki kontrolü değildir). */
  function available({ state, actor, ctx = {} }) {
    return Object.keys(actions).filter((action) => check({ state, orderType, action, actor, ctx }).ok);
  }

  return { orderType, states: [...states], actions, check, available };
}
