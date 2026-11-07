-- AlterTable
ALTER TABLE "ProfileOrder" ADD COLUMN     "priceTableId" TEXT,
ADD COLUMN     "priceTableName" TEXT;

-- CreateTable
CREATE TABLE "_CustomerProfileCatalogs" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CustomerProfileCatalogs_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_CustomerProfileCatalogs_B_index" ON "_CustomerProfileCatalogs"("B");

-- AddForeignKey
ALTER TABLE "_CustomerProfileCatalogs" ADD CONSTRAINT "_CustomerProfileCatalogs_A_fkey" FOREIGN KEY ("A") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CustomerProfileCatalogs" ADD CONSTRAINT "_CustomerProfileCatalogs_B_fkey" FOREIGN KEY ("B") REFERENCES "ProfilePriceTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

