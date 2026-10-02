import { useState, useEffect, useRef, useCallback } from 'react';
import { DollarSign, CreditCard, Lock, MapPin, User, Home } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@hushbox/ui/button';
import { OverlayContent, OverlayFooter, OverlayHeader } from '@hushbox/ui/overlay';
import {
  TEST_IDS,
  ERROR_CODES,
  dollarsToNanoUsd,
  asErrorCode,
  friendlyErrorMessage,
  nanoUsdToDollarString,
  parseNanoUSD,
  PRICEABLE_AMOUNT,
  type ErrorCode,
  type ListTransactionsResponse,
} from '@hushbox/shared';
import { FormInput } from '@/components/shared/form-input';
import { DevOnly } from '@/components/shared/dev-only';
import { ApiError, getErrorBody } from '@/lib/api/api';
import { dispatchCountFor, dispatchFailuresFor } from '@/lib/api/idempotent-mutation';
import { env } from '@/lib/platform/env';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav.js';
import {
  useInitiatePayment,
  useBalance,
  useTransactions,
  billingKeys,
} from '@/hooks/billing/billing.js';
import { usePaymentForm } from '@/hooks/billing/use-payment-form.js';
import { HelcimLogo } from './helcim-logo.js';
import {
  loadHelcimScript,
  tokenizeWithHelcim,
  type HelcimTokenResult,
} from '../../lib/billing/helcim-loader.js';
import { MOCK_TEST_CARDS } from '../../lib/billing/helcim-mock.js';
import { MIN_DEPOSIT_AMOUNT, MAX_DEPOSIT_AMOUNT } from '../../lib/billing/payment-validation.js';

// `pending_credit` is the terminal state after an `awaiting_webhook` charge
// whose credit did not land before the poll timeout. The processor has ALREADY
// approved the charge; the credit is guaranteed by the webhook + the
// `payment.verify.v1` reconcile job. Its action starts a SEPARATE deposit under
// a fresh Idempotency-Key, which is what a deposit made after a resolved one
// is; the server refuses it while the first is still unresolved.
//
// `unconfirmed` is the terminal state after the `POST /billing/payments` request
// was dispatched but threw (network drop / 5xx) — the charge OUTCOME IS UNKNOWN:
// the processor may already have approved before our response was lost. Its
// retry is the same fresh-key deposit, and the same server refusal is what
// keeps it from becoming a second charge against an unresolved first one.
// Neither state decides here that a second charge is safe: the pre-claim guard
// answers that, and answering it client-side would be a second authority over
// the same question.
//
// `in_flight` is the terminal state after the server REFUSED this deposit
// because an earlier one of the same user's is still unresolved. Nothing was
// charged here: that refusal is answered before the processor is called. It
// still offers no re-charge, because the EARLIER charge may yet land and a
// second deposit is the duplicate the server guard exists to stop.
type PaymentState =
  | 'idle'
  | 'processing'
  | 'success'
  | 'error'
  | 'pending_credit'
  | 'unconfirmed'
  | 'in_flight';

// Max time to wait for the asynchronous webhook credit to land (observed as the
// balance increasing) before telling the user to check their balance. A charged
// user must always get a resolution even if the webhook is slow.
const POLLING_TIMEOUT_MS = 60_000;

// How often to re-read the balance while awaiting the webhook credit.
const BALANCE_POLL_INTERVAL_MS = 2000;

/**
 * The Helcim.js tokenization token, from the env registry (VITE_HELCIM_JS_TOKEN).
 * Resolution mirrors the tokenizer selection below (mock ⟺ env.isLocalDev): the
 * real Helcim.js tokenizer runs whenever we are NOT in local dev — production AND
 * CiE2E, which both build the real path and supply the token — so there the token
 * MUST exist (its absence is a deploy/CI misconfiguration, fail fast). Local dev
 * and CiVitest (isLocalDev) use the mock tokenizer, which ignores the token, so it
 * resolves to empty. Selection is by MODE (via env.isLocalDev), never by whether
 * the var happens to be present.
 */
function resolveHelcimJsToken(isLocalDev: boolean): string {
  if (isLocalDev) return '';
  const token = import.meta.env['VITE_HELCIM_JS_TOKEN'] as string | undefined;
  if (token === undefined || token === '') {
    throw new Error('VITE_HELCIM_JS_TOKEN is not configured');
  }
  return token;
}

// Resolves a thrown payment error into a registered code. ApiError carries a
// machine-readable code (e.g. VALIDATION); a throw naming none is a payment
// failure with no condition of its own to report, which PAYMENT_FAILED is.
function resolvePaymentErrorCode(error: unknown): ErrorCode {
  return asErrorCode(getErrorBody(error)?.code) ?? ERROR_CODES.PAYMENT_FAILED;
}

// A thrown response on this route that PROVES the request carrying it never
// reached the handler AND names a condition that lifts on its own. Other
// pre-handler refusals prove the first half — `pipelineAuthorize` answers 401
// or 403 and returns before any handler runs — but only a condition that
// clears without the payer doing anything makes the retryable card the right
// answer, so this predicate admits the narrower set and every refusal outside
// it stays an unknown outcome. Both rate-limit layers `POST /billing/payments`
// declares are counted at the pipeline edge, and that stage returns without
// calling the handler on either of its two refusals: no `payments` pre-claim,
// no processor call, so a fresh-key re-submit duplicates nothing THIS request
// did.
//
// Two status-and-code pairs, one per refusal that stage can answer, and the
// pairing is deliberate rather than a code list: a code admitted at any status
// would admit a response the pipeline never wrote.
//
//   429 `RATE_LIMITED`         — the counter was reached and the cap was spent.
//   503 `RATE_LIMIT_UNAVAILABLE` — the counter could not be reached at all.
//
// Their conditions lift differently and both qualify. A cap refills on a clock
// the response names; a counter outage clears whenever the counter comes back,
// which is unbounded but is still nothing the payer's own state, funds or input
// bear on — and that gloss, not the bounded window, is what the second conjunct
// asks for. Which is also why only the first renders a wait: the outage carries
// no `retryAfterSeconds` because there is none to carry.
//
// A status paired with a code is the whole discriminator because it is the
// whole of what the client can observe. No response carries a "the handler
// never ran" marker, and the reasoning above is what stands in for one; each of
// its citations is checkable in `apps/api` — the layers' `countedAt: 'edge'` in
// `apps/api/src/slices/billing/rate-limit-posture.ts`; `RATE_LIMITED` sitting outside the
// charge handler's own vocabulary, the billing slice raising no rate-limited
// domain error and counting no layer inside its flow; and
// `RATE_LIMIT_UNAVAILABLE` being unreachable from any handler at all — the
// domain-error taxonomy maps onto it from nowhere, so only the pipeline stage
// that names the constant can emit it, and an architecture rule refuses that
// name anywhere else in the Worker.
//
// That second citation is why the predicate is this route's rather than shared:
// the chat and media routes answer the 429 pair from INSIDE their handlers. A
// generic 503 stays outside the predicate for the reason the third citation
// draws: the Helcim adapter answers `UNAVAILABLE` to every charge whose outcome
// it cannot settle — a processor server error, and an approval whose
// transaction it could not read — so that code proves nothing about whether the
// handler ran. It is the code, not the status, that separates the two 503s.
const PIPELINE_RATE_LIMIT_REFUSALS = [
  { status: 429, code: ERROR_CODES.RATE_LIMITED },
  { status: 503, code: ERROR_CODES.RATE_LIMIT_UNAVAILABLE },
] as const;

function isPipelineRateLimitRefusal(error: unknown): boolean {
  const code = getErrorBody(error)?.code;
  if (!(error instanceof ApiError)) return false;
  return PIPELINE_RATE_LIMIT_REFUSALS.some(
    (refusal) => error.status === refusal.status && code === refusal.code
  );
}

// Whether the retry out of the error card re-offers what the payer already
// typed instead of a blank form. True for exactly the codes in
// {@link PIPELINE_RATE_LIMIT_REFUSALS}: the payer's card is not what was
// refused, so clearing costs them a card number and a CVV — which browsers do
// not autofill — for a condition that lifts without them doing anything.
// Every other code clears, the unrecognised one included: a
// declined card is a reason to enter a DIFFERENT one, and clearing is the
// answer this predicate gives whenever it cannot say the card was blameless.
//
// Reads the code alone, where {@link isPipelineRateLimitRefusal} demands the
// status too, because the two decide different questions. That one decides
// whether a fresh-key re-submit can double-charge and must not be widened by a
// status it never checked. This one decides only whether the form's inputs
// survive, and it reads a code already passed through {@link showError} — the
// sole path by which a refusal's code reaches that state — rather than a
// response body.
function retryReusesTheTypedCard(code: ErrorCode): boolean {
  return PIPELINE_RATE_LIMIT_REFUSALS.some((refusal) => refusal.code === code);
}

// Whether this charge is provably unmade: every request it dispatched came
// back refused before the handler ran.
//
// {@link isPipelineRateLimitRefusal} speaks for the request that carried the
// refusal, never for the mutation, which dispatches one request per attempt: a
// transport failure is retried automatically, and the attempt it lost may have
// reached the handler and charged before its response vanished. That automatic
// retry is itself safe — it reuses the variables reference, so the idempotency
// key is the same one — but the manual re-submit the retryable card offers
// re-tokenizes and mints a fresh key the server cannot dedup against the lost
// attempt. So every dispatched request has to be accounted for, not just the
// one whose refusal ended the mutation.
//
// Both numbers count events rather than reading the mutation's `failureCount`.
// That count reads the retry policy as much as the wire: one refusal settles at
// one where the policy declines to retry it and at one per attempt where it
// retries, though nothing about what the server did has changed. A proof
// resting on it therefore changes meaning whenever that policy does, in the one
// place where being wrong means telling a payer we may have taken money we did
// not take. A dispatch is counted where its key is authored and its failure
// where the transport records it, so a retry adds one to each and moves neither
// the comparison nor the verdict.
//
// An unaccounted dispatch — one whose failure nothing recorded, or a mutation
// that dispatched nothing this reading can see — leaves the counts apart, which
// is the unknown outcome and the safe answer.
function chargeProvablyUnmade(variables: object): boolean {
  const dispatched = dispatchCountFor(variables);
  const refused = dispatchFailuresFor(variables).filter((failure) =>
    isPipelineRateLimitRefusal(failure)
  ).length;
  return dispatched > 0 && refused === dispatched;
}

// The server's refusal of a deposit made while this user already has one it has
// not resolved. It is answered from inside the pre-claim transaction, before
// any processor call, so the request carrying it charged nothing. The status
// and the code are a PAIR for the reason {@link isPipelineRateLimitRefusal}
// pairs its own: the code read at another status is a response this route never
// wrote.
//
// Deliberately unconditioned on the per-dispatch accounting
// {@link chargeProvablyUnmade} rests on. That accounting decides whether a
// RETRYABLE card is safe, and this refusal renders a state offering no retry at
// all, so a lost earlier attempt changes nothing the state claims. It also
// cannot be one: an automatic retry carries the same idempotency key, and the
// server returns a claimed row's stored outcome before the guard is reached
// (`initiateCardPayment` in `apps/api/src/slices/billing/domain/payments/payments.ts`
// returns on `!claim.created`), so this code never answers a request whose own
// charge landed.
function isUnresolvedDepositRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    getErrorBody(error)?.code === ERROR_CODES.PAYMENT_IN_FLIGHT
  );
}

// The code for a failure that named no condition: an unplaceable throw, and the
// state's value before any failure has landed on it. A code rather than its
// copy, because the code is what both readers of that state need — the card
// renders the registered wording for it, and the retry reads it to decide
// whether the payer's card is what was refused.
const NO_CONDITION_NAMED = ERROR_CODES.PAYMENT_FAILED;

// The code for a charge the processor rejected (`failed`) or that could not be
// confirmed before expiry (`expired`). These are returned inline by the single
// `POST /billing/payments` call — no code is thrown, so this maps status → code.
function statusErrorCode(status: 'failed' | 'expired'): ErrorCode {
  return status === 'expired' ? ERROR_CODES.PAYMENT_EXPIRED : ERROR_CODES.PAYMENT_DECLINED;
}

/**
 * A top-up against a negative balance clears the deficit before it adds
 * spendable funds (BILLING §Fee Structure), so a $5 payment against a $0.50
 * deficit leaves $4.50 available. Stating it at the point of payment is what
 * stops the user discovering it from a balance that does not match the amount
 * they paid.
 *
 * This is a payment disclosure, not a refusal, which is why it carries amounts
 * at all: §Notices 6's no-magnitude rule governs the refusal vocabulary, whose
 * copy is single-homed in the shared money layer.
 */
function negativeBalanceDisclosure(
  balanceNanoUsd: string,
  amountDollars: string
): string | undefined {
  const balance = BigInt(parseNanoUSD(balanceNanoUsd));
  if (balance >= 0n) return undefined;

  const deficit = nanoUsdToDollarString((-balance).toString());
  // A partially-typed amount is worth nothing yet, so it prices as zero rather
  // than reaching a converter that refuses what it cannot price exactly. The
  // gate is the converter's own grammar — the same one `validateAmount` admits
  // this field on — so the disclosure prices whatever the form will accept.
  const priced = PRICEABLE_AMOUNT.test(amountDollars) ? amountDollars : '0';
  const netCredit = BigInt(parseNanoUSD(dollarsToNanoUsd(priced))) + balance;

  return netCredit > 0n
    ? `Your balance is $${deficit} behind. This payment clears that first and adds $${nanoUsdToDollarString(netCredit.toString())} to your balance.`
    : `Your balance is $${deficit} behind. A payment clears that before crediting your balance.`;
}

/**
 * The amount a new charge starts at: the payer's most recent deposit, as the field
 * writes dollars, read from the newest-first deposit page. Nothing before the read
 * lands or when there has been no deposit.
 */
function lastDepositAmount(page: ListTransactionsResponse | undefined): string | undefined {
  const amountNanoUsd = page?.transactions[0]?.amount;
  return amountNanoUsd === undefined ? undefined : nanoUsdToDollarString(amountNanoUsd);
}

interface PaymentSuccessCardProps {
  /**
   * The charged amount, already converted to NanoUSD at charge time. The card
   * takes the charged value rather than live form state because the amount
   * field stays editable through the charge and the awaiting-webhook poll,
   * both of which precede this card: a dollar string read at render time can
   * be a figure that was never charged, or one the exact-cent helper refuses.
   */
  amountNanoUsd: string;
  onClose?: (() => void) | undefined;
}

function PaymentSuccessCard({
  amountNanoUsd,
  onClose,
}: Readonly<PaymentSuccessCardProps>): React.JSX.Element {
  return (
    <OverlayContent>
      <OverlayHeader title="Payment Successful" description="Your deposit has been processed" />
      <div className="py-4 text-center">
        <p className="text-primary text-2xl font-semibold">
          +${nanoUsdToDollarString(amountNanoUsd)}
        </p>
        <p className="text-muted-foreground mt-2">Added to your balance</p>
      </div>
      <OverlayFooter>
        <Button
          type="button"
          onClick={() => {
            onClose?.();
          }}
        >
          Close
        </Button>
      </OverlayFooter>
    </OverlayContent>
  );
}

// Copy for the two cards whose charge has not resolved. `approved` = an
// `awaiting_webhook` charge whose credit is guaranteed but slow (the card was
// approved). `unconfirmed` = a charge whose outcome is unknown because the
// request threw (the card MAY have been charged). Their actions differ with
// what each one knows: after an approved charge the next deposit is an addition
// to a payment that landed, after an unknown one it is that payment's retry.
const PROCESSING_COPY = {
  approved: {
    title: 'Payment Processing',
    description: 'Your card was approved and the credit is on its way',
    body: "Your payment is processing and will be credited shortly. Check your balance in a moment, or contact support if it doesn't appear.",
    retryLabel: 'Add More Credits',
  },
  unconfirmed: {
    title: 'Payment Unconfirmed',
    description: "We couldn't confirm your payment",
    body: "Check your balance in a moment. If the credit doesn't appear, you can try again; a second payment is refused while the first one is still being confirmed.",
    retryLabel: 'Try Again',
  },
} as const;

interface PaymentProcessingCardProps {
  onDone?: (() => void) | undefined;
  onRefreshBalance: () => void;
  onRetry: () => void;
  variant: 'approved' | 'unconfirmed';
}

/**
 * Terminal state for a charge whose credit has not been observed: either an
 * approved (`awaiting_webhook`) charge whose credit did not land before the poll
 * timeout, or a charge whose request threw with an unknown outcome. Its balance
 * re-read and its close are the answers for the payment already made; the third
 * action starts a new one, which the server refuses while the first is still
 * unresolved. Required rather than optional so the card cannot be mounted
 * without the state that admits the next attempt (see `handleReset`).
 */
function PaymentProcessingCard({
  onDone,
  onRefreshBalance,
  onRetry,
  variant,
}: Readonly<PaymentProcessingCardProps>): React.JSX.Element {
  const copy = PROCESSING_COPY[variant];
  return (
    <OverlayContent>
      <OverlayHeader title={copy.title} description={copy.description} />
      <div className="py-4 text-center">
        <p className="text-muted-foreground">{copy.body}</p>
      </div>
      <OverlayFooter>
        <Button type="button" variant="outline" onClick={onRefreshBalance}>
          Refresh Balance
        </Button>
        <Button
          type="button"
          onClick={() => {
            onDone?.();
          }}
        >
          Done
        </Button>
      </OverlayFooter>
      {/* Under the two actions, and quiet: re-reading the balance is what
          resolves this state for a payment that landed, and paying again is
          the step to take only once that has not. */}
      <div className="flex justify-center">
        <Button type="button" variant="link" size="sm" onClick={onRetry}>
          {copy.retryLabel}
        </Button>
      </div>
    </OverlayContent>
  );
}

interface PaymentInFlightCardProps {
  onClose?: (() => void) | undefined;
  onRefreshBalance: () => void;
}

/**
 * Terminal state for a deposit the server refused because an earlier one of the
 * same user's is still unresolved. Its own card rather than a
 * {@link PaymentProcessingCard} variant: that card answers for a charge that was
 * made and may yet settle, this one for a charge that was never made. Only this
 * one must never offer a way to start another purchase, and sharing a card would
 * tie that rule to the other's.
 *
 * The body is the registered copy for the code and nothing else, so the wording
 * stays single-homed (CODE-RULES §Error Responses).
 */
function PaymentInFlightCard({
  onClose,
  onRefreshBalance,
}: Readonly<PaymentInFlightCardProps>): React.JSX.Element {
  return (
    <OverlayContent>
      <OverlayHeader
        title="Purchase Not Started"
        description="An earlier purchase is still being confirmed"
      />
      <p className="text-muted-foreground py-4 text-center">
        {friendlyErrorMessage(ERROR_CODES.PAYMENT_IN_FLIGHT)}
      </p>
      <OverlayFooter>
        <Button type="button" variant="outline" onClick={onRefreshBalance}>
          Refresh Balance
        </Button>
        <Button
          type="button"
          onClick={() => {
            onClose?.();
          }}
        >
          Close
        </Button>
      </OverlayFooter>
    </OverlayContent>
  );
}

interface PaymentErrorCardProps {
  errorMessage: string;
  // The processor's own words, present only when Helcim supplied them. It is
  // rendered as attributed supporting detail, so a substitute of ours here
  // would read as Helcim's; the loader leaves it absent rather than filling it.
  processorDetail: string | null;
  onCancel?: (() => void) | undefined;
  onRetry: () => void;
}

function PaymentErrorCard({
  errorMessage,
  processorDetail,
  onCancel,
  onRetry,
}: Readonly<PaymentErrorCardProps>): React.JSX.Element {
  return (
    <OverlayContent>
      <OverlayHeader title="Payment Failed" description="We couldn't process your payment" />
      <div className="py-4 text-center">
        <p className="text-destructive">{errorMessage}</p>
        {processorDetail !== null && (
          <p className="text-muted-foreground mt-2 text-sm">{processorDetail}</p>
        )}
      </div>
      <OverlayFooter>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="button" onClick={onRetry}>
          Try Again
        </Button>
      </OverlayFooter>
    </OverlayContent>
  );
}

interface CardFormSectionProps {
  scriptError: string | null;
  scriptLoaded: boolean;
  form: ReturnType<typeof usePaymentForm>;
}

function CardFormSection({
  scriptError,
  scriptLoaded,
  form,
}: Readonly<CardFormSectionProps>): React.JSX.Element {
  if (scriptError) {
    return (
      <div className="py-4 text-center">
        <p className="text-destructive mb-4">{scriptError}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            globalThis.location.reload();
          }}
        >
          Reload Page
        </Button>
      </div>
    );
  }

  if (scriptLoaded) {
    return (
      <>
        <FormInput
          id="cardNumber"
          label="Card Number"
          type="text"
          inputMode="numeric"
          autoComplete="cc-number"
          icon={<CreditCard className="h-5 w-5" />}
          value={form.cardFields.cardNumber}
          onChange={(e) => {
            form.handleFieldChange('cardNumber', e.target.value);
          }}
          maxLength={19}
          aria-invalid={!!form.cardValidation.cardNumber.error}
          {...(form.cardValidation.cardNumber.error != null && {
            error: form.cardValidation.cardNumber.error,
          })}
          success={form.cardValidation.cardNumber.success}
        />

        <div className="flex gap-3">
          <div className="flex-1">
            <FormInput
              id="cardExpiryDate"
              label="Expiry (MM/YY)"
              type="text"
              inputMode="numeric"
              autoComplete="cc-exp"
              value={form.cardFields.expiry}
              onChange={(e) => {
                form.handleFieldChange('expiry', e.target.value);
              }}
              maxLength={7}
              aria-invalid={!!form.cardValidation.expiry.error}
              {...(form.cardValidation.expiry.error != null && {
                error: form.cardValidation.expiry.error,
              })}
              success={form.cardValidation.expiry.success}
            />
          </div>
          {/* Hidden fields for Helcim - it needs month and year separately */}
          <input type="hidden" id="cardExpiryMonth" value={form.expiryParts.month} />
          <input type="hidden" id="cardExpiryYear" value={form.expiryParts.year} />

          <div className="flex-1">
            <FormInput
              id="cardCVV"
              label="CVV"
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              icon={<Lock className="h-5 w-5" />}
              value={form.cardFields.cvv}
              onChange={(e) => {
                form.handleFieldChange('cvv', e.target.value);
              }}
              maxLength={4}
              aria-invalid={!!form.cardValidation.cvv.error}
              {...(form.cardValidation.cvv.error != null && {
                error: form.cardValidation.cvv.error,
              })}
              success={form.cardValidation.cvv.success}
            />
          </div>
        </div>

        {/* Name on Card - Required by Helcim */}
        <FormInput
          id="cardHolderName"
          label="Name on Card"
          type="text"
          autoComplete="cc-name"
          icon={<User className="h-5 w-5" />}
          value={form.cardFields.cardHolderName}
          onChange={(e) => {
            form.handleFieldChange('cardHolderName', e.target.value);
          }}
          aria-invalid={!!form.cardValidation.cardHolderName.error}
          {...(form.cardValidation.cardHolderName.error != null && {
            error: form.cardValidation.cardHolderName.error,
          })}
          success={form.cardValidation.cardHolderName.success}
        />

        {/* Billing Address - Required by Helcim */}
        <FormInput
          id="cardHolderAddress"
          label="Billing Address"
          type="text"
          autoComplete="address-line1"
          icon={<Home className="h-5 w-5" />}
          value={form.cardFields.billingAddress}
          onChange={(e) => {
            form.handleFieldChange('billingAddress', e.target.value);
          }}
          aria-invalid={!!form.cardValidation.billingAddress.error}
          {...(form.cardValidation.billingAddress.error != null && {
            error: form.cardValidation.billingAddress.error,
          })}
          success={form.cardValidation.billingAddress.success}
        />

        <FormInput
          id="cardHolderPostalCode"
          label="ZIP Code"
          type="text"
          autoComplete="postal-code"
          icon={<MapPin className="h-5 w-5" />}
          value={form.cardFields.zipCode}
          onChange={(e) => {
            form.handleFieldChange('zipCode', e.target.value);
          }}
          maxLength={10}
          aria-invalid={!!form.cardValidation.zipCode.error}
          {...(form.cardValidation.zipCode.error != null && {
            error: form.cardValidation.zipCode.error,
          })}
          success={form.cardValidation.zipCode.success}
        />

        {/* Hidden results container for Helcim response */}
        <div id="helcimResults" className="hidden">
          <input type="hidden" id="response" />
          <input type="hidden" id="responseMessage" />
          <input type="hidden" id="cardToken" />
          <input type="hidden" id="cardType" />
          <input type="hidden" id="cardF4L4" />
          <input type="hidden" id="customerCode" />
        </div>
      </>
    );
  }

  return (
    <div className="py-8 text-center" data-testid={TEST_IDS.helcimLoading}>
      <p className="text-muted-foreground">Loading payment form...</p>
    </div>
  );
}

interface PaymentFormActionsProps {
  onCancel?: (() => void) | undefined;
  scriptLoaded: boolean;
  paymentState: PaymentState;
  isPaymentPending: boolean;
}

function PaymentFormActions({
  onCancel,
  scriptLoaded,
  paymentState,
  isPaymentPending,
}: Readonly<PaymentFormActionsProps>): React.JSX.Element {
  const isProcessing = paymentState === 'processing' || isPaymentPending;

  return (
    <OverlayFooter>
      {onCancel && (
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button
        type="submit"
        form="helcimForm"
        disabled={!scriptLoaded || isProcessing}
        loading={isProcessing}
        loadingLabel="Processing..."
      >
        Purchase
      </Button>
    </OverlayFooter>
  );
}

/** What a completed charge reports: the amount charged, in NanoUSD. */
export interface CompletedCharge {
  amountNanoUsd: string;
}

interface PaymentFormProps {
  onSuccess?: (charge: CompletedCharge) => void;
  onCancel?: () => void;
}

export function PaymentForm({
  onSuccess,
  onCancel,
}: Readonly<PaymentFormProps>): React.JSX.Element {
  const isDevMode = env.isLocalDev;
  const jsToken = resolveHelcimJsToken(isDevMode);

  const { data: lastDeposit } = useTransactions({ type: 'deposit', limit: 1 });
  const form = usePaymentForm({ initialAmount: lastDepositAmount(lastDeposit) });

  const [paymentState, setPaymentState] = useState<PaymentState>('idle');
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode>(NO_CONDITION_NAMED);
  const [processorDetail, setProcessorDetail] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  // The amount sent to the processor, kept so the success card shows what was
  // charged rather than whatever the still-editable amount field holds by the
  // time the charge settles.
  const [chargedNanoUsd, setChargedNanoUsd] = useState<string>('0');
  const simulateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paymentFormRef = useRef<HTMLFormElement>(null);
  // Whether a charge attempt has already been started. A ref, not the
  // `processing` state, because the state a handler reads is its render's
  // value: a second submit event dispatched before React commits that render
  // still sees `idle`. Submitting the form element directly reaches the
  // handler whatever the Purchase button renders as — `requestSubmit()` does
  // exactly that — so the disabled button gates the click path only, and a
  // second attempt would re-tokenize and mint a fresh Idempotency-Key the
  // server cannot dedup against the first, double-charging the card.
  const chargeStartedRef = useRef(false);
  // The purchased-wallet snapshot (NanoUSD, bigint) captured when
  // awaiting-webhook polling begins; the credit is confirmed when the live
  // balance rises above it.
  const pollBaselineRef = useRef<bigint>(0n);
  useFormEnterNav(paymentFormRef);

  const queryClient = useQueryClient();
  const initiatePayment = useInitiatePayment();
  // Enabled unconditionally: the payment form is only shown to a signed-in
  // principal or a billing-portal credential, and polling needs the query
  // mounted to refetch.
  const { data: balanceData, refetch: refetchBalance } = useBalance({ enabled: true });
  // A deposit credits the purchased wallet; the poll watches that value rise.
  const displayBalance = balanceData?.purchased.balanceNanoUsd ?? '0';
  const deficitDisclosure = negativeBalanceDisclosure(displayBalance, form.amount);

  const stopPolling = useCallback((): void => {
    setIsPolling(false);
  }, []);

  // The one way into the terminal error card. Routing every failure through it
  // is what keeps a previous attempt's processor wording from surviving under a
  // later failure that carried none.
  const showError = useCallback((code: ErrorCode, detail?: string): void => {
    setPaymentState('error');
    setErrorCode(code);
    setProcessorDetail(detail ?? null);
  }, []);

  // Deadline: a real timer, not a data dependency, so it fires once polling
  // starts and clears when polling settles or the form unmounts. Polling only
  // ever begins after an `awaiting_webhook` charge, so a timeout here means an
  // approved charge whose credit is still in flight — the terminal
  // `pending_credit` state (never a re-chargeable error).
  useEffect(() => {
    if (!isPolling) return;

    const timer = setTimeout(() => {
      setIsPolling(false);
      setPaymentState('pending_credit');
    }, POLLING_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [isPolling]);

  // Re-read the balance on an interval while awaiting the webhook credit. There
  // is no payment-status route — the credit's arrival is observed as the balance
  // increasing past the pre-charge baseline.
  useEffect(() => {
    if (!isPolling) return;

    const interval = setInterval(() => {
      void refetchBalance();
    }, BALANCE_POLL_INTERVAL_MS);

    return () => {
      clearInterval(interval);
    };
  }, [isPolling, refetchBalance]);

  // Confirm the credit the moment the polled balance rises above the baseline.
  useEffect(() => {
    if (!isPolling) return;
    if (parseNanoUSD(displayBalance) <= pollBaselineRef.current) return;

    stopPolling();
    setPaymentState('success');
    void queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
    onSuccess?.({ amountNanoUsd: chargedNanoUsd });
  }, [isPolling, displayBalance, stopPolling, queryClient, onSuccess, chargedNanoUsd]);

  // Which terminal state a THROWN charge dispatch lands in. Its own callback
  // because it is one decision with three answers, and the reasoning each answer
  // rests on is what makes it one.
  const handleChargeFailure = useCallback(
    (error: unknown, variables: object): void => {
      if (isUnresolvedDepositRefusal(error)) {
        setPaymentState('in_flight');
        return;
      }
      if (chargeProvablyUnmade(variables)) {
        // The refusal's own code, because the guard admits two conditions and
        // they read differently: one says the cap was spent, the other that
        // the limiter could not be reached at all. A code named here instead
        // would tell a payer to wait out a window that was never counted.
        //
        // `details.retryAfterSeconds` rides the over-cap body and is
        // deliberately not rendered. It is the FIRST refusing layer's window,
        // and on a route whose IP layer refuses a payer for a co-tenant's
        // traffic that is a floor rather than a wait: showing it would promise
        // a time the shared window cannot keep. It is also not ours to word
        // here — the registered copy for the code is the single-homed
        // user-facing text (CODE-RULES §Error Responses), and the card's one
        // supporting-detail slot is attributed to the processor, so a duration
        // placed there would read as Helcim's.
        showError(resolvePaymentErrorCode(error));
        return;
      }
      // Reaching here means {@link chargeProvablyUnmade} did not hold, so
      // nothing has proven the handler never ran and the outcome is UNKNOWN:
      // this block begins at the charge dispatch, and a network drop or 5xx can
      // hide a charge the processor already approved, as can an earlier attempt
      // whose response was lost. The server's confirmed
      // no-charge signal arrives inline as a `failed`/`expired` STATUS
      // (handled above), never as a throw. Routing a throw to the retryable
      // error card would let a fresh-key re-submit double-charge, so land in
      // the terminal no-re-charge state instead.
      setPaymentState('unconfirmed');
    },
    [showError]
  );

  const handleTokenizationResult = useCallback(
    async (result: HelcimTokenResult): Promise<void> => {
      if (!result.success) {
        showError(ERROR_CODES.PAYMENT_TOKENIZATION_FAILED, result.errorMessage);
        return;
      }

      if (!result.cardToken || !result.customerCode) {
        showError(ERROR_CODES.PAYMENT_CARD_DETAILS_MISSING);
        return;
      }

      // Pricing precedes the charge, so it is deliberately outside the dispatch
      // `try`: a converter refusal here has sent nothing, and presenting it
      // as a possibly-completed payment would be a lie. Defence in depth, not dead
      // code: `validateAmount` is the gate that keeps an unpriceable amount out of
      // this step, and this is the boundary that holds if that gate is ever wrong
      // or bypassed.
      let amountNanoUsd: string;
      try {
        amountNanoUsd = dollarsToNanoUsd(form.amount);
      } catch {
        showError(ERROR_CODES.VALIDATION);
        return;
      }
      setChargedNanoUsd(amountNanoUsd);

      // Held outside the dispatch `try` because the catch identifies the
      // mutation by this object: TanStack stores the variables reference it was
      // called with, and the idempotency key is minted per reference.
      const charge = {
        amountNanoUsd,
        cardToken: result.cardToken,
        customerCode: result.customerCode,
      };

      try {
        // One pre-claimed charge (Pattern D): tokenize first (done), then this
        // single call. The server mints the payment id; there is no create step.
        const response = await initiatePayment.mutateAsync(charge);

        if (response.status === 'completed') {
          setPaymentState('success');
          onSuccess?.({ amountNanoUsd });
        } else if (response.status === 'awaiting_webhook') {
          // Baseline the balance now, before the credit lands, then poll for it.
          pollBaselineRef.current = parseNanoUSD(displayBalance);
          setIsPolling(true);
        } else {
          showError(statusErrorCode(response.status));
        }
      } catch (error) {
        handleChargeFailure(error, charge);
      }
    },
    [initiatePayment, onSuccess, form.amount, displayBalance, showError, handleChargeFailure]
  );

  useEffect(() => {
    let mounted = true;

    const loadScript = async (): Promise<void> => {
      try {
        await loadHelcimScript({ useMock: isDevMode });
        if (mounted) {
          setScriptLoaded(true);
        }
      } catch {
        if (mounted) {
          // The thrown reason is internal wording (a script-tag failure), so the
          // registered copy is what renders; nothing surfaces the raw message.
          setScriptError(friendlyErrorMessage(ERROR_CODES.PAYMENT_FORM_LOAD_FAILED));
        }
      }
    };

    void loadScript();

    return () => {
      mounted = false;
    };
  }, [isDevMode]);

  useEffect(() => {
    return () => {
      if (simulateTimerRef.current !== null) {
        clearTimeout(simulateTimerRef.current);
      }
    };
  }, []);

  // Clear stale Helcim results so a failed tokenization (which only rewrites
  // response/responseMessage) can never be read with a previous run's token.
  // eslint-disable-next-line unicorn/consistent-function-scoping -- React handler
  const clearHelcimResults = (): void => {
    for (const id of [
      'response',
      'responseMessage',
      'cardToken',
      'customerCode',
      'cardType',
      'cardF4L4',
    ]) {
      const el = document.querySelector<HTMLInputElement>(`#${id}`);
      if (el) el.value = '';
    }
  };

  const populateTestCard = (cvv: string): void => {
    clearHelcimResults(); // Clear FIRST, before form updates trigger re-renders
    if (!form.amount) {
      form.handleAmountChange('100');
    }
    form.handleFieldChange('cardNumber', MOCK_TEST_CARDS.SUCCESS.number);
    form.handleFieldChange('expiry', MOCK_TEST_CARDS.SUCCESS.expiry);
    form.handleFieldChange('cvv', cvv);
    form.handleFieldChange('cardHolderName', 'Test User');
    form.handleFieldChange('billingAddress', '123 Test St');
    form.handleFieldChange('zipCode', '12345');
  };

  const handleSimulateSuccess = (): void => {
    populateTestCard(MOCK_TEST_CARDS.SUCCESS.cvv);
    simulateTimerRef.current = setTimeout(() => {
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      formEl?.requestSubmit();
    }, 100);
  };

  const handleSimulateFailure = (): void => {
    populateTestCard(MOCK_TEST_CARDS.DECLINE.cvv);
    simulateTimerRef.current = setTimeout(() => {
      const formEl = document.querySelector<HTMLFormElement>('#helcimForm');
      formEl?.requestSubmit();
    }, 100);
  };

  const runTokenizationAndCharge = useCallback(async (): Promise<void> => {
    try {
      // Tokenize FIRST (Helcim.js or the local mock behind the same typed
      // loader contract), then charge in one call once the token is read. The
      // server mints the payment id — no pre-create step.
      const result = await tokenizeWithHelcim();
      await handleTokenizationResult(result);
    } catch (error) {
      // Tokenization never completed (processor missing or trigger threw):
      // nothing was charged, so the retryable error card is safe.
      showError(resolvePaymentErrorCode(error));
    }
  }, [handleTokenizationResult, showError]);

  const handleSubmit = (e: React.SyntheticEvent): void => {
    e.preventDefault();

    if (chargeStartedRef.current) {
      return;
    }

    if (!form.validateAll()) {
      return;
    }

    chargeStartedRef.current = true;
    setPaymentState('processing');
    clearHelcimResults();
    void runTokenizationAndCharge();
  };

  const handleReset = (): void => {
    // The only route back to a submittable form: every other outcome renders a
    // terminal card with no form under it, so this is where the next attempt
    // is admitted.
    chargeStartedRef.current = false;
    // The refused card is worth keeping only where the refusal was not about
    // it. Everything kept is the same React state the form has been editing all
    // along — no store, no cache, nothing that outlives this component — so
    // keeping it is the absence of a wipe rather than a place values are put.
    if (!retryReusesTheTypedCard(errorCode)) {
      form.reset();
    }
    setPaymentState('idle');
    // Back to the no-condition code, so a LATER outcome that never reaches
    // `showError` — the unconfirmed and pending-credit cards both retry through
    // here — cannot be read as this refusal and spare a card it says nothing
    // about.
    setErrorCode(NO_CONDITION_NAMED);
    setProcessorDetail(null);
    setIsPolling(false);
  };

  if (paymentState === 'success') {
    return <PaymentSuccessCard amountNanoUsd={chargedNanoUsd} onClose={onCancel} />;
  }

  if (paymentState === 'pending_credit') {
    return (
      <PaymentProcessingCard
        variant="approved"
        onDone={onCancel}
        onRefreshBalance={() => {
          void refetchBalance();
        }}
        onRetry={handleReset}
      />
    );
  }

  if (paymentState === 'unconfirmed') {
    return (
      <PaymentProcessingCard
        variant="unconfirmed"
        onDone={onCancel}
        onRefreshBalance={() => {
          void refetchBalance();
        }}
        onRetry={handleReset}
      />
    );
  }

  if (paymentState === 'in_flight') {
    return (
      <PaymentInFlightCard
        onClose={onCancel}
        onRefreshBalance={() => {
          void refetchBalance();
        }}
      />
    );
  }

  if (paymentState === 'error') {
    return (
      <PaymentErrorCard
        errorMessage={friendlyErrorMessage(errorCode)}
        processorDetail={processorDetail}
        onCancel={onCancel}
        onRetry={handleReset}
      />
    );
  }

  return (
    <OverlayContent>
      <OverlayHeader title="Add Credits" description="Enter amount and card details" />
      <form
        ref={paymentFormRef}
        id="helcimForm"
        onSubmit={handleSubmit}
        className="space-y-2"
        noValidate
      >
        {/* Hidden Helcim fields */}
        <input type="hidden" id="token" value={jsToken} />
        <input type="hidden" id="amount" value={form.amount} />

        <FormInput
          id="amount-input"
          label="Amount (USD) - Minimum $5"
          type="number"
          min={MIN_DEPOSIT_AMOUNT}
          max={MAX_DEPOSIT_AMOUNT}
          step="0.01"
          icon={<DollarSign className="h-5 w-5" />}
          value={form.amount}
          onChange={(e) => {
            form.handleAmountChange(e.target.value);
          }}
          onKeyDown={(e) => {
            // Block non-numeric characters that number inputs allow (e, E, +, -)
            if (['e', 'E', '+', '-'].includes(e.key)) {
              e.preventDefault();
            }
          }}
          aria-invalid={!!form.amountValidation.error}
          error={form.amountValidation.error}
          success={form.amountValidation.success}
          className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />

        {deficitDisclosure !== undefined && (
          <p role="status" className="text-muted-foreground text-sm">
            {deficitDisclosure}
          </p>
        )}

        <CardFormSection scriptError={scriptError} scriptLoaded={scriptLoaded} form={form} />

        {paymentState === 'processing' && (
          <div className="py-4 text-center">
            <p className="text-muted-foreground animate-pulse">Processing payment...</p>
          </div>
        )}
      </form>

      <PaymentFormActions
        onCancel={onCancel}
        scriptLoaded={scriptLoaded}
        paymentState={paymentState}
        isPaymentPending={initiatePayment.isPending}
      />

      <div data-testid={TEST_IDS.helcimSecurityBadge} className="flex justify-center">
        <HelcimLogo />
      </div>

      <DevOnly>
        <div className="flex gap-2" data-testid={TEST_IDS.devSimulationButtons}>
          <Button
            type="button"
            variant="outline"
            onClick={handleSimulateSuccess}
            disabled={paymentState === 'processing'}
            className="flex-1"
            data-testid={TEST_IDS.simulateSuccessBtn}
          >
            Simulate Success
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleSimulateFailure}
            disabled={paymentState === 'processing'}
            className="flex-1"
            data-testid={TEST_IDS.simulateFailureBtn}
          >
            Simulate Failure
          </Button>
        </div>
      </DevOnly>
    </OverlayContent>
  );
}
