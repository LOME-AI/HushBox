ALTER TABLE "messages" ALTER COLUMN "cost" TYPE numeric(20, 8) USING "cost"::numeric(20, 8);
