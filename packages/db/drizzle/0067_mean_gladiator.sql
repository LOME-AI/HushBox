CREATE TABLE "newsletter_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletter_webhook_events_event_id_unique" UNIQUE("event_id")
);
