CREATE TYPE "public"."balance_transaction_type" AS ENUM('deposit', 'usage', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'awaiting_webhook', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "balance_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"balance_after" numeric(20, 8) NOT NULL,
	"type" "balance_transaction_type" NOT NULL,
	"payment_id" text,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"helcim_transaction_id" text,
	"card_type" text,
	"card_last_four" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_received_at" timestamp with time zone,
	CONSTRAINT "payments_helcim_transaction_id_unique" UNIQUE("helcim_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "title" SET DEFAULT 'New Conversation';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "balance_transaction_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "balance" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_transactions_user_id_idx" ON "balance_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_user_id_idx" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "payments_helcim_transaction_id_idx" ON "payments" USING btree ("helcim_transaction_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_balance_transaction_id_balance_transactions_id_fk" FOREIGN KEY ("balance_transaction_id") REFERENCES "public"."balance_transactions"("id") ON DELETE set null ON UPDATE no action;