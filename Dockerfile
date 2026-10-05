# syntax=docker/dockerfile:1
# Takip — üretim imajı. İki hedef:
#   runner : uygulama (Next.js standalone)
#   tools  : migration ve yönetim komutları (prisma CLI + betikler)

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Sürüm numarası her yayında değişir ama bağımlılıkları etkilemez. Bu aşama package.json / package-lock.json'ın SÜRÜMÜ
# SABİTLENMİŞ bir kopyasını üretir; "deps" yalnızca bu kopyayı alır. Kopyanın içeriği değişmedikçe (bağımlılıklar
# değişmedikçe) aşağıdaki npm ci katmanı önbellekten gelir — her yayında ~1,2 GB'lık yeni bir katman (ve o kadar derleme
# önbelleği) oluşmaz (karar 134). Uygulama gerçek package.json'ı "builder" aşamasındaki COPY . . ile alır (sürüm oradan okunur).
FROM base AS manifest
COPY package.json package-lock.json* ./
RUN node -e "const fs=require('fs');for(const f of ['package.json','package-lock.json']){if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='0.0.0';if(j.packages&&j.packages[''])j.packages[''].version='0.0.0';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');}"

FROM base AS deps
COPY --from=manifest /app/package.json /app/package-lock.json* ./
COPY prisma ./prisma
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

FROM deps AS builder
COPY . .
RUN npx prisma generate && npx next build

FROM builder AS tools
ENV NODE_ENV=production
# migration + temel veri (tekrar çalıştırılabilir)
CMD ["sh", "-c", "npx prisma migrate deploy && node prisma/seed/base.mjs"]

FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 UPLOAD_DIR=/data/uploads
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app \
  && mkdir -p /data/uploads && chown -R app:app /data
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma
# Derlenen commit (sunucu kurulumu verir; /surum ve logonun üzerindeki ipucunda görünür)
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
