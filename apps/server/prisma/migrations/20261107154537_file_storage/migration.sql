-- AlterTable
ALTER TABLE "file_attachments" ADD COLUMN     "storage_key" VARCHAR(300);

-- CreateIndex
CREATE INDEX "file_attachments_workbook_id_idx" ON "file_attachments"("workbook_id");
