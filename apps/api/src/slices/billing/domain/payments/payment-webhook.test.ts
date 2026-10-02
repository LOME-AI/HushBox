import { describe, expect, it } from 'vitest';
import { signalPaymentWebhookDisposition } from './payment-webhook.js';
import type { PaymentWebhookDisposition } from './payment-webhook.js';
import type { SafeLogFields, Telemetry } from '../../../../lib/telemetry/index.js';

interface SignalRecorder {
  readonly telemetry: Telemetry;
  readonly warns: { msg: string; fields: SafeLogFields | undefined }[];
  readonly captures: { message: string; code: string }[];
}

function recordingTelemetry(): SignalRecorder {
  const warns: SignalRecorder['warns'] = [];
  const captures: SignalRecorder['captures'] = [];
  const telemetry: Telemetry = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, fields?: SafeLogFields) => {
      warns.push({ msg, fields });
    },
    error: () => {},
    captureError: (error: Error, code: string) => {
      captures.push({ message: error.message, code });
    },
  };
  return { telemetry, warns, captures };
}

function signal(disposition: PaymentWebhookDisposition): SignalRecorder {
  const recorder = recordingTelemetry();
  signalPaymentWebhookDisposition(recorder.telemetry, disposition);
  return recorder;
}

const PAYMENT_ID = 'payment-id';

describe('signalPaymentWebhookDisposition', () => {
  it('pages once with a content-free message when a clawback posted', () => {
    const recorder = signal({ kind: 'clawback-posted', paymentId: PAYMENT_ID });
    expect(recorder.captures).toEqual([
      {
        message: 'payment chargeback clawed back and the account was locked',
        code: 'payment_clawback_posted',
      },
    ]);
  });

  it('warns alongside the clawback page under the same registered code', () => {
    const recorder = signal({ kind: 'clawback-posted', paymentId: PAYMENT_ID });
    expect(recorder.warns).toEqual([
      {
        msg: 'payment chargeback clawed back and the account was locked',
        fields: { errorCode: 'payment_clawback_posted' },
      },
    ]);
  });

  it('pages once with a content-free message on a dispute we hold no payment for', () => {
    const recorder = signal({ kind: 'dispute-unmatched' });
    expect(recorder.captures).toEqual([
      { message: 'payment dispute matched no payment', code: 'payment_dispute_unmatched' },
    ]);
  });

  it('pages once with a content-free message on a dispute whose account is gone', () => {
    const recorder = signal({ kind: 'dispute-orphaned', paymentId: PAYMENT_ID });
    expect(recorder.captures).toEqual([
      {
        message: 'payment dispute has no account to charge back',
        code: 'payment_dispute_orphaned',
      },
    ]);
  });

  it('pages once with a content-free message when funds arrived with no wallet', () => {
    const recorder = signal({ kind: 'completed-without-wallet', paymentId: PAYMENT_ID });
    expect(recorder.captures).toEqual([
      {
        message: 'payment completed with no wallet to credit',
        code: 'payment_completed_without_wallet',
      },
    ]);
  });

  it('pages once on the surfaced dispute that takes no action', () => {
    const recorder = signal({ kind: 'notify-only' });
    expect(recorder.captures).toEqual([
      { message: 'payment dispute surfaced, no action taken', code: 'payment_dispute_surfaced' },
    ]);
  });

  it('keeps the surfaced dispute warn line it already had', () => {
    const recorder = signal({ kind: 'notify-only' });
    expect(recorder.warns).toEqual([
      {
        msg: 'payment dispute surfaced, no action taken',
        fields: { errorCode: 'payment_dispute_surfaced' },
      },
    ]);
  });

  it('warns without paging on an idempotent clawback replay', () => {
    const recorder = signal({ kind: 'clawback-duplicate', paymentId: PAYMENT_ID });
    expect(recorder.warns).toEqual([
      { msg: 'payment clawback replay took no further action', fields: undefined },
    ]);
    expect(recorder.captures).toEqual([]);
  });

  it('warns without paging on a decline for a payment we never had', () => {
    const recorder = signal({ kind: 'decline-unmatched' });
    expect(recorder.warns).toEqual([
      { msg: 'payment decline matched no payment', fields: undefined },
    ]);
    expect(recorder.captures).toEqual([]);
  });

  it('keeps the unrecognized-event warn line it already had', () => {
    const recorder = signal({ kind: 'ignored' });
    expect(recorder.warns).toEqual([
      { msg: 'unrecognized payment webhook event ignored', fields: undefined },
    ]);
    expect(recorder.captures).toEqual([]);
  });

  it.each<PaymentWebhookDisposition>([
    { kind: 'credited', paymentId: PAYMENT_ID },
    { kind: 'already-completed', paymentId: PAYMENT_ID },
    { kind: 'decline-recorded', paymentId: PAYMENT_ID },
    { kind: 'unmatched' },
  ])('stays silent on $kind, the payment flow working as designed', (disposition) => {
    const recorder = signal(disposition);
    expect(recorder.warns).toEqual([]);
    expect(recorder.captures).toEqual([]);
  });
});
