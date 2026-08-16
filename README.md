# HookRelay

**Reliable webhook delivery with retries, idempotency, signed requests, dead-letter handling, and complete delivery history.**

HookRelay is a backend reliability project focused on the problems that appear after simply sending an HTTP request is no longer enough.

Webhook receivers can time out, return transient failures, become temporarily unavailable, or successfully process a request just before the sender crashes. HookRelay is designed to make those failure modes explicit and recoverable.

## What HookRelay Does

HookRelay accepts events and reliably delivers them to registered webhook endpoints.

The delivery pipeline is designed around:

- durable event and delivery state
- asynchronous webhook delivery
- HMAC-SHA256 request signing
- bounded exponential retries
- retryable vs terminal failure classification
- idempotent event ingestion
- persisted delivery-attempt history
- dead-letter handling
- manual replay
- delivery observability

## Delivery Flow

```text
Client
  |
  | Create Event
  v
HookRelay API
  |
  | Persist Event + Delivery
  v
PostgreSQL
  |
  | Schedule Delivery
  v
Redis / BullMQ
  |
  v
Worker
  |
  | Signed HTTP POST
  v
Webhook Endpoint
  |
  v
Attempt Result
  |
  v
PostgreSQL
```

PostgreSQL is the durable source of truth for events, deliveries, and attempts.

Redis/BullMQ is used for asynchronous scheduling and worker coordination rather than authoritative business state.

## Delivery Lifecycle

A delivery moves through a small explicit state machine:

```text
queued
  |
  v
delivering
  |
  +-----------------------> delivered
  |
  v
retry_scheduled
  |
  v
delivering
  |
  +-----------------------> delivered
  |
  v
dead_letter
```

Transient failures can be retried according to a bounded backoff policy.

Once the retry budget is exhausted, the delivery moves to a dead-letter state where it can be inspected and manually replayed.

## Reliability Semantics

### At-Least-Once Delivery

HookRelay targets **at-least-once delivery** rather than claiming exactly-once delivery.

A receiver may successfully process a webhook while the HookRelay worker crashes before recording that success. In that situation, retrying the delivery can cause the receiver to observe the same logical event more than once.

Stable event identity and idempotent consumers are therefore part of the delivery model.

### Idempotent Ingestion

Clients can attach an idempotency key when creating an event.

Repeated requests representing the same logical event should resolve to the same persisted event and delivery rather than creating duplicates.

### Durable State

Accepted work is persisted before asynchronous processing.

Queue state is treated as execution infrastructure, not the only record that work exists. This allows delivery state to remain inspectable and recoverable even when workers or queue infrastructure fail.

## Webhook Signing

Outbound webhook requests are authenticated using HMAC-SHA256.

The signature is derived from:

```text
timestamp + "." + raw_request_body
```

Webhook requests include headers such as:

```text
X-HookRelay-Event-Id
X-HookRelay-Timestamp
X-HookRelay-Signature
```

Consumers can independently verify that a request was produced by HookRelay and that its payload was not modified in transit.

## Retry Policy

HookRelay uses bounded retries rather than retrying failures indefinitely.

The retry classifier distinguishes between failures such as:

**Retryable**

- network errors
- timeouts
- selected 5xx responses
- optionally HTTP 429

**Terminal**

- ordinary client-side 4xx responses such as malformed or unauthorized requests

Retries use an exponential backoff schedule with a fixed maximum number of attempts.

## Delivery History

Every delivery maintains an inspectable history containing information such as:

- attempt number
- start and completion time
- HTTP response status
- delivery latency
- error information
- retry scheduling
- final delivery state

This makes failure behavior visible instead of hiding it inside background workers.

## Failure Demo

The project includes a controllable webhook receiver that can intentionally fail its first few requests.

Example:

```text
Attempt #1 → HTTP 500
        ↓
Retry scheduled
        ↓
Attempt #2 → HTTP 500
        ↓
Retry scheduled
        ↓
Attempt #3 → HTTP 200
        ↓
Delivered
```

A second failure path demonstrates:

```text
Retries exhausted
        ↓
Dead Letter
        ↓
Manual Replay
        ↓
Delivered
```

These scenarios are the primary proof of HookRelay's reliability behavior.

## Architecture

HookRelay uses a small set of clearly separated responsibilities:

```text
React Dashboard
       |
       v
Fastify API
       |
       v
PostgreSQL
       |
       v
Redis / BullMQ
       |
       v
Delivery Worker
       |
       v
External Webhook Endpoint
```

The API accepts and persists work.

Workers perform unreliable outbound network operations asynchronously.

PostgreSQL retains durable application state and delivery history.

Redis/BullMQ coordinates queued and delayed work.

## Technology

- TypeScript
- Node.js
- Fastify
- PostgreSQL
- Redis
- BullMQ
- React
- Vite
- Docker Compose
- Vitest

## Project Status

HookRelay is currently under active development.
