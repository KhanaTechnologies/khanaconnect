const crypto = require('crypto');

function truthyEnv(value) {
  if (value == null || value === '') return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function timingSafeEqualStr(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try {
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

let warnedOrderMisconfig = false;
let warnedBookingMisconfig = false;

/**
 * Order payment callback (`POST .../orders/update-order-payment`).
 * When ORDER_PAYMENT_WEBHOOK_ENABLED is true, requires ORDER_PAYMENT_WEBHOOK_SECRET and matching
 * `x-webhook-secret` or `x-order-webhook-secret`. Otherwise optional (no check).
 */
function orderPaymentWebhookOk(req) {
  if (!truthyEnv(process.env.ORDER_PAYMENT_WEBHOOK_ENABLED)) return true;

  const expected = process.env.ORDER_PAYMENT_WEBHOOK_SECRET;
  if (!expected) {
    if (!warnedOrderMisconfig) {
      console.warn(
        'ORDER_PAYMENT_WEBHOOK_ENABLED is true but ORDER_PAYMENT_WEBHOOK_SECRET is empty — rejecting callbacks until configured'
      );
      warnedOrderMisconfig = true;
    }
    return false;
  }

  const got = req.headers['x-webhook-secret'] || req.headers['x-order-webhook-secret'];
  return timingSafeEqualStr(got, expected);
}

/**
 * Booking payment confirmation (`POST .../bookings/:id/payment-confirmation`).
 * When BOOKING_PAYMENT_WEBHOOK_ENABLED is true, requires BOOKING_PAYMENT_WEBHOOK_SECRET and matching
 * `x-webhook-secret` or `x-booking-webhook-secret`. Otherwise optional (no check).
 */
function bookingPaymentWebhookOk(req) {
  if (!truthyEnv(process.env.BOOKING_PAYMENT_WEBHOOK_ENABLED)) return true;

  const expected = process.env.BOOKING_PAYMENT_WEBHOOK_SECRET;
  if (!expected) {
    if (!warnedBookingMisconfig) {
      console.warn(
        'BOOKING_PAYMENT_WEBHOOK_ENABLED is true but BOOKING_PAYMENT_WEBHOOK_SECRET is empty — rejecting callbacks until configured'
      );
      warnedBookingMisconfig = true;
    }
    return false;
  }

  const got = req.headers['x-webhook-secret'] || req.headers['x-booking-webhook-secret'];
  return timingSafeEqualStr(got, expected);
}

module.exports = {
  truthyEnv,
  orderPaymentWebhookOk,
  bookingPaymentWebhookOk,
};
