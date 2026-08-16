CREATE TYPE "public"."delivery_status" AS ENUM('queued', 'delivering', 'retry_scheduled', 'delivered', 'dead_letter');--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" "delivery_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"replayed_from_delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_attempt_count_nonnegative" CHECK ("deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"response_status" integer,
	"latency_ms" integer,
	"error_message" text,
	CONSTRAINT "delivery_attempts_delivery_attempt_unique" UNIQUE("delivery_id","attempt_number"),
	CONSTRAINT "delivery_attempts_attempt_number_positive" CHECK ("delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "delivery_attempts_latency_nonnegative" CHECK ("delivery_attempts"."latency_ms" is null or "delivery_attempts"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "events_event_type_nonempty" CHECK (char_length(btrim("events"."event_type")) > 0),
	CONSTRAINT "events_idempotency_key_nonempty" CHECK (char_length(btrim("events"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"signing_secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_name_nonempty" CHECK (char_length(btrim("webhook_endpoints"."name")) > 0),
	CONSTRAINT "webhook_endpoints_signing_secret_nonempty" CHECK (char_length(btrim("webhook_endpoints"."signing_secret")) > 0)
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_replayed_from_delivery_id_deliveries_id_fk" FOREIGN KEY ("replayed_from_delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_event_id_idx" ON "deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "deliveries_endpoint_id_idx" ON "deliveries" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "deliveries_status_next_attempt_idx" ON "deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "delivery_attempts_delivery_id_idx" ON "delivery_attempts" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_created_at_idx" ON "webhook_endpoints" USING btree ("created_at","id");