-- `consent_ip` is the mailing list's consent evidence, so it holds the address
-- and nothing else. The rewrite is what makes the cast reachable: the column
-- previously admitted a word for a caller no header carried an address for, and
-- Postgres has no cast from that to `inet`. Loopback is the address the resolver
-- now answers in its place. Any other value that will not cast is a row nobody
-- can explain, so the cast is left to fail on it rather than guess.
UPDATE "newsletter_subscribers" SET "consent_ip" = '127.0.0.1' WHERE "consent_ip" = 'unknown';--> statement-breakpoint
ALTER TABLE "newsletter_subscribers" ALTER COLUMN "consent_ip" SET DATA TYPE inet USING "consent_ip"::inet;
