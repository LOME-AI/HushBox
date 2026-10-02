CREATE TABLE "terms_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terms_acceptances_user_revision_unique" UNIQUE("user_id","revision"),
	CONSTRAINT "terms_acceptances_revision_positive" CHECK ("terms_acceptances"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;