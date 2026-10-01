-- CreateTable
CREATE TABLE "GlassBilling" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fxRate" DECIMAL(10,4),
    "fxDate" DATE,
    "fxSource" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidAmount" DECIMAL(14,2),
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlassBilling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlassBilling_orderId_key" ON "GlassBilling"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FgoDocument_orderId_kind_key" ON "FgoDocument"("orderId", "kind");

-- AddForeignKey
ALTER TABLE "GlassBilling" ADD CONSTRAINT "GlassBilling_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

