import { PrismaClient } from '@prisma/client';

// Geliştirmede sıcak yeniden yüklemede bağlantı sızmasın diye tek örnek tutulur.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
