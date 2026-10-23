-- CreateTable
CREATE TABLE "FactoryTeam" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "salesUserId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactoryTeam_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FactoryTeam_name_key" ON "FactoryTeam"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryTeam_salesUserId_key" ON "FactoryTeam"("salesUserId");

-- AddForeignKey
ALTER TABLE "FactoryTeam" ADD CONSTRAINT "FactoryTeam_salesUserId_fkey" FOREIGN KEY ("salesUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

