import { ROLES } from '../data/roles.js';

/** Rolleri ve yetkilerini kurar; fazla yetkiyi kaldırır, eksik olanı ekler. */
export const rolesStep = {
  name: 'roller ve yetkiler',
  available: (db) => typeof db.role?.upsert === 'function' && typeof db.rolePermission?.createMany === 'function',
  async run(db) {
    for (const r of ROLES) {
      const role = await db.role.upsert({
        where: { name: r.code },
        create: { name: r.code, description: r.description },
        update: { description: r.description },
      });
      await db.rolePermission.deleteMany({ where: { roleId: role.id, key: { notIn: r.permissions } } });
      await db.rolePermission.createMany({
        data: r.permissions.map((key) => ({ roleId: role.id, key })),
        skipDuplicates: true,
      });
    }
    return `${ROLES.length} rol`;
  },
};
