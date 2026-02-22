ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_type_unique" UNIQUE ("user_id", "type");
