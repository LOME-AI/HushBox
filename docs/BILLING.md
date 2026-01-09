# Billing System

This document describes how billing, user tiers, and model access work in LOME-CHAT.

---

## User Tiers

| Tier      | Model Access | Persistence      | Balance Source                           |
| --------- | ------------ | ---------------- | ---------------------------------------- |
| **Guest** | Basic only   | None (ephemeral) | N/A - message count limit                |
| **Free**  | Basic only   | Full             | Daily allowance (resets at UTC midnight) |
| **Paid**  | All models   | Full             | Prepaid balance                          |

**Tier derivation:**

- Guest: No authenticated user
- Free: Authenticated user with `balance = 0`
- Paid: Authenticated user with `balance > 0`

Tier logic is centralized in `packages/shared/src/tiers.ts`.

---

## Model Classification

Models are classified as **Basic** or **Premium** based on:

- **Premium**: Price ≥ 75th percentile OR released within recency threshold
- **Basic**: Everything else

Classification is calculated dynamically when models are fetched and cached with the model list.

See `packages/shared/src/models.ts` for classification constants and logic.

---

## Balance Consumption

For authenticated users, charges are deducted in this order:

1. **Primary balance** (prepaid credits from Helcim payments)
2. **Free allowance** (only if primary = 0 AND using a basic model)

The free allowance:

- Resets to a fixed amount at UTC midnight (lazy reset on access)
- Does not stack (resets to exactly the configured amount, not additive)
- Only applies to basic models

See `getDeductionSource()` in `packages/shared/src/tiers.ts`.

---

## New User Bonus

When a user creates an account, they receive a welcome credit added to their primary balance.

See `packages/db/src/schema/users.ts` for the default balance value.

---

## Billing Flow

### Development (Mock OpenRouter)

1. User sends message
2. Message streams via mock OpenRouter client (echoes input)
3. Cost is **estimated**:
   - Characters ÷ 4 = estimated tokens
   - Tokens × model pricing (fetched from real OpenRouter `/models` endpoint)
   - Fees applied to token cost
   - Storage fee added
4. Balance deducted immediately after stream completes

### Production (Real OpenRouter)

1. User sends message
2. Message streams via real OpenRouter API
3. Cost is **exact**:
   - `getGenerationStats(generationId)` returns `total_cost` from OpenRouter
   - Fees applied directly to `total_cost` (no token math needed)
   - Storage fee added
4. Balance deducted via fire-and-forget after stream completes

---

## Fee Structure

All model usage incurs a combined fee. The fee breakdown and calculation functions are defined in:

- `packages/shared/src/constants.ts` - Fee rate constants
- `packages/shared/src/pricing.ts` - Fee application functions

Fees apply to model usage cost only. Storage fees are separate and not marked up.

---

## Storage Fees

Messages are charged a per-character storage fee covering long-term retention.

The storage fee calculation is based on:

- Cost per GB of storage
- Retention period
- Characters per message

See `packages/shared/src/constants.ts` for storage fee constants and derivation.

---

## Guest Usage

Guests (unauthenticated users) can use the chat with limitations:

- Basic models only
- Limited messages per day
- No persistence (messages exist only in browser memory)

Guest identity is tracked via:

- Primary: `guestToken` stored in localStorage
- Backstop: IP address hash (catches localStorage clearing)

See `packages/db/src/schema/guest-usage.ts` for the tracking table.

---

## Helcim Integration

Credit loading is handled via Helcim payment processing:

### Development

- Mock Helcim client (no real charges)
- Payments confirm immediately

### Production

- Real Helcim API integration
- Webhook-based confirmation flow
- Payment states: `pending` → `awaiting_webhook` → `confirmed`

See:

- `apps/api/src/services/helcim/` - Helcim client implementation
- `apps/api/src/routes/billing.ts` - Payment endpoints
- `apps/api/src/routes/webhooks.ts` - Webhook handler

---

## Configuration Reference

| Configuration          | Location                                         |
| ---------------------- | ------------------------------------------------ |
| Fee rates              | `packages/shared/src/constants.ts`               |
| Storage costs          | `packages/shared/src/constants.ts`               |
| Pricing functions      | `packages/shared/src/pricing.ts`                 |
| Tier logic & constants | `packages/shared/src/tiers.ts`                   |
| Model classification   | `packages/shared/src/models.ts`                  |
| Welcome credit         | `packages/db/src/schema/users.ts`                |
| Guest limits           | `packages/shared/src/tiers.ts`                   |
| Payment schemas        | `packages/db/src/schema/payments.ts`             |
| Balance transactions   | `packages/db/src/schema/balance-transactions.ts` |
