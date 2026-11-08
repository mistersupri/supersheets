-- CreateTable
CREATE TABLE "feed_tokens" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "prefix" VARCHAR(12) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "feed_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feed_tokens_token_hash_key" ON "feed_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "feed_tokens_workbook_id_idx" ON "feed_tokens"("workbook_id");

-- AddForeignKey
ALTER TABLE "feed_tokens" ADD CONSTRAINT "feed_tokens_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
