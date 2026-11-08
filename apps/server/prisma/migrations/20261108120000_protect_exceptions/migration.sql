-- AlterTable
ALTER TABLE "protected_ranges" ADD COLUMN "except_ranges" VARCHAR(40)[] DEFAULT ARRAY[]::VARCHAR(40)[];
