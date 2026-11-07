-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'user',
    "avatar" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_resets" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbooks" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "folder_id" UUID,
    "color" VARCHAR(20) NOT NULL DEFAULT 'green',
    "is_trashed" BOOLEAN NOT NULL DEFAULT false,
    "trashed_at" TIMESTAMP(3),
    "link_access" VARCHAR(20) NOT NULL DEFAULT 'restricted',
    "revision" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_stars" (
    "user_id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_stars_pkey" PRIMARY KEY ("user_id","workbook_id")
);

-- CreateTable
CREATE TABLE "workbook_opens" (
    "user_id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_opens_pkey" PRIMARY KEY ("user_id","workbook_id")
);

-- CreateTable
CREATE TABLE "worksheets" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "position" INTEGER NOT NULL,
    "default_column_width" INTEGER NOT NULL DEFAULT 100,
    "default_row_height" INTEGER NOT NULL DEFAULT 24,
    "frozen_rows" INTEGER NOT NULL DEFAULT 0,
    "frozen_columns" INTEGER NOT NULL DEFAULT 0,
    "is_protected" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worksheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worksheet_metadata" (
    "worksheet_id" UUID NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "worksheet_metadata_pkey" PRIMARY KEY ("worksheet_id")
);

-- CreateTable
CREATE TABLE "cells" (
    "id" UUID NOT NULL,
    "worksheet_id" UUID NOT NULL,
    "row_index" INTEGER NOT NULL,
    "column_index" INTEGER NOT NULL,
    "raw_value" TEXT,
    "formula" TEXT,
    "calculated_value" JSONB,
    "data_type" VARCHAR(16) NOT NULL DEFAULT 'empty',
    "style_id" UUID,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cell_styles" (
    "id" UUID NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "font_family" VARCHAR(80),
    "font_size" INTEGER,
    "bold" BOOLEAN NOT NULL DEFAULT false,
    "italic" BOOLEAN NOT NULL DEFAULT false,
    "underline" BOOLEAN NOT NULL DEFAULT false,
    "text_color" VARCHAR(20),
    "background_color" VARCHAR(20),
    "horizontal_align" VARCHAR(10),
    "vertical_align" VARCHAR(10),
    "number_format" VARCHAR(80),
    "border_config" JSONB,
    "wrap_text" BOOLEAN NOT NULL DEFAULT false,
    "extra" JSONB,

    CONSTRAINT "cell_styles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_permissions" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_invitations" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "permission" VARCHAR(20) NOT NULL,
    "invited_by" UUID NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_revisions" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "revision_number" BIGINT NOT NULL,
    "user_id" UUID,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'cells',
    "changes" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_snapshots" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "revision_number" BIGINT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_comments" (
    "id" UUID NOT NULL,
    "workbook_id" UUID NOT NULL,
    "worksheet_id" UUID NOT NULL,
    "cell_reference" VARCHAR(20) NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workbook_comments_replies" (
    "id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_comments_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_validations" (
    "id" UUID NOT NULL,
    "worksheet_id" UUID NOT NULL,
    "range" VARCHAR(40) NOT NULL,
    "rule" JSONB NOT NULL,

    CONSTRAINT "data_validations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conditional_formats" (
    "id" UUID NOT NULL,
    "worksheet_id" UUID NOT NULL,
    "range" VARCHAR(40) NOT NULL,
    "rule" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "conditional_formats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protected_ranges" (
    "id" UUID NOT NULL,
    "worksheet_id" UUID NOT NULL,
    "range" VARCHAR(40),
    "description" TEXT,
    "editor_ids" UUID[],

    CONSTRAINT "protected_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_attachments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "workbook_id" UUID,
    "filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(120) NOT NULL,
    "size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" VARCHAR(60) NOT NULL,
    "target_type" VARCHAR(30),
    "target_id" TEXT,
    "detail" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_token_hash_key" ON "password_resets"("token_hash");

-- CreateIndex
CREATE INDEX "folders_owner_id_idx" ON "folders"("owner_id");

-- CreateIndex
CREATE INDEX "workbooks_owner_id_idx" ON "workbooks"("owner_id");

-- CreateIndex
CREATE INDEX "worksheets_workbook_id_idx" ON "worksheets"("workbook_id");

-- CreateIndex
CREATE UNIQUE INDEX "cells_worksheet_id_row_index_column_index_key" ON "cells"("worksheet_id", "row_index", "column_index");

-- CreateIndex
CREATE UNIQUE INDEX "cell_styles_hash_key" ON "cell_styles"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_permissions_workbook_id_user_id_key" ON "workbook_permissions"("workbook_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_invitations_workbook_id_email_key" ON "workbook_invitations"("workbook_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "workbook_revisions_workbook_id_revision_number_key" ON "workbook_revisions"("workbook_id", "revision_number");

-- CreateIndex
CREATE INDEX "workbook_snapshots_workbook_id_revision_number_idx" ON "workbook_snapshots"("workbook_id", "revision_number");

-- CreateIndex
CREATE INDEX "workbook_comments_workbook_id_idx" ON "workbook_comments"("workbook_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbooks" ADD CONSTRAINT "workbooks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbooks" ADD CONSTRAINT "workbooks_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_stars" ADD CONSTRAINT "workbook_stars_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_stars" ADD CONSTRAINT "workbook_stars_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_opens" ADD CONSTRAINT "workbook_opens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_opens" ADD CONSTRAINT "workbook_opens_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksheets" ADD CONSTRAINT "worksheets_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksheet_metadata" ADD CONSTRAINT "worksheet_metadata_worksheet_id_fkey" FOREIGN KEY ("worksheet_id") REFERENCES "worksheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cells" ADD CONSTRAINT "cells_worksheet_id_fkey" FOREIGN KEY ("worksheet_id") REFERENCES "worksheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cells" ADD CONSTRAINT "cells_style_id_fkey" FOREIGN KEY ("style_id") REFERENCES "cell_styles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_permissions" ADD CONSTRAINT "workbook_permissions_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_permissions" ADD CONSTRAINT "workbook_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_invitations" ADD CONSTRAINT "workbook_invitations_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_revisions" ADD CONSTRAINT "workbook_revisions_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_revisions" ADD CONSTRAINT "workbook_revisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_snapshots" ADD CONSTRAINT "workbook_snapshots_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_comments" ADD CONSTRAINT "workbook_comments_workbook_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_comments" ADD CONSTRAINT "workbook_comments_worksheet_id_fkey" FOREIGN KEY ("worksheet_id") REFERENCES "worksheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_comments" ADD CONSTRAINT "workbook_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_comments_replies" ADD CONSTRAINT "workbook_comments_replies_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "workbook_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workbook_comments_replies" ADD CONSTRAINT "workbook_comments_replies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_validations" ADD CONSTRAINT "data_validations_worksheet_id_fkey" FOREIGN KEY ("worksheet_id") REFERENCES "worksheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditional_formats" ADD CONSTRAINT "conditional_formats_worksheet_id_fkey" FOREIGN KEY ("worksheet_id") REFERENCES "worksheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protected_ranges" ADD CONSTRAINT "protected_ranges_worksheet_id_fkey" FOREIGN KEY ("worksheet_id") REFERENCES "worksheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
