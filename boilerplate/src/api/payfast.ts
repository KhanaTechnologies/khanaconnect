import type { PayfastCheckoutResponse } from './client';

/**
 * Send the browser to PayFast with the form the API built and signed.
 * Every field goes unchanged: editing any of them breaks the signature.
 * Sandbox vs live is decided by the API (PAYFAST_SANDBOX), never here.
 */
export function redirectToPayfast(checkout: PayfastCheckoutResponse): void {
  const form = document.createElement('form');
  form.method = checkout.method;
  form.action = checkout.action;
  for (const [name, value] of Object.entries(checkout.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

/** PayFast returns to the client's fixed return_url without our ids, so remember them here. */
const KEY = 'khana:lastCheckout';
export type LastCheckout = { kind: 'order' | 'booking'; id: string };

export function rememberCheckout(c: LastCheckout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode: the success page falls back to ?order= / ?booking= */
  }
}

export function lastCheckout(): LastCheckout | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as LastCheckout) : null;
  } catch {
    return null;
  }
}
