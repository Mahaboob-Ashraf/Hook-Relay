# HookRelay V1 Project Specification

## Thesis

HookRelay is a compact, single-tenant webhook delivery platform built to demonstrate backend reliability: durable asynchronous delivery, idempotent event ingestion, authenticated outbound delivery, controlled retries, dead-letter handling, replay, failure recovery, and useful observability.

V1 is a portfolio-scale modular application. PostgreSQL owns durable business state. Redis and BullMQ will later provide non-authoritative scheduling and delivery infrastructure. A Fastify API and a separate worker share backend modules while running as independent processes. React/Vite provides a focused operational UI.

## V1 scope

- Webhook endpoint management
- Idempotent event ingestion and durable delivery records
- Asynchronous outbound delivery through a worker
- HMAC request signing
- Retry and backoff policy
- Dead-letter state and manual replay
- Delivery/attempt inspection and basic operational metrics
- A demo receiver for end-to-end demonstration

## Explicit non-goals

- Kafka
- Kubernetes
- Microservice architecture
- Multi-region systems
- Exactly-once delivery claims
- Authentication or multi-tenancy
- Billing
- AI features
- A generic workflow or integration platform

