/**
 * Payment gateway routes (PayFast ITN — public, no custom webhook secret).
 * @see https://developers.payfast.co.za/docs#step_4_confirm_payment
 *
 * Checkout must send m_payment_id = Mongo order _id (24-char hex).
 * PayFast includes merchant_id on ITN — must match the order's client's PayFast merchant_id.
 */

const express = require('express');
const mongoose = require('mongoose');
const { wrapRoute } = require('../helpers/failureEmail');
const { validateItnWithPayfast } = require('../helpers/payfast');
const { fulfillGatewayPayment } = require('../helpers/fulfillGatewayPayment');
const Client = require('../models/client');
const { Order } = require('../models/order');

const router = express.Router();

function amountsMatch(order, amountGrossStr) {
  const gross = parseFloat(String(amountGrossStr || '').replace(',', '.'));
  if (Number.isNaN(gross)) return false;
  const expected = Number(order.finalPrice);
  if (Number.isNaN(expected)) return false;
  return Math.abs(gross - expected) < 0.02;
}

/**
 * PayFast ITN (Instant Transaction Notification)
 * PayFast POSTs application/x-www-form-urlencoded data here.
 * We confirm with PayFast's validate endpoint; on VALID + COMPLETE we mark the order paid.
 */
router.post('/payfast/itn', wrapRoute(async (req, res) => {
  const body = req.body || {};

  const paymentStatus = (body.payment_status || '').trim();
  const merchantId = body.merchant_id;
  const mPaymentId = (body.m_payment_id || '').trim();
  const amountGross = body.amount_gross;

  if (!merchantId || !mPaymentId) {
    console.warn('PayFast ITN missing merchant_id or m_payment_id');
    return res.status(200).send('');
  }

  if (!mongoose.Types.ObjectId.isValid(mPaymentId)) {
    console.warn('PayFast ITN invalid m_payment_id:', mPaymentId);
    return res.status(200).send('');
  }

  const client = await Client.findOne({ merchant_id: Number(merchantId) });
  if (!client) {
    console.warn('PayFast ITN unknown merchant_id:', merchantId);
    return res.status(200).send('');
  }

  const order = await Order.findOne({ _id: mPaymentId, clientID: client.clientID });
  if (!order) {
    console.warn('PayFast ITN order not found for m_payment_id:', mPaymentId);
    return res.status(200).send('');
  }

  const confirmed = await validateItnWithPayfast(body);
  if (!confirmed) {
    console.warn('PayFast ITN validate did not return VALID for order', mPaymentId);
    return res.status(200).send('');
  }

  if (paymentStatus !== 'COMPLETE') {
    console.log(`PayFast ITN acknowledged (${paymentStatus}), no fulfillment for order`, mPaymentId);
    return res.status(200).send('');
  }

  if (!amountsMatch(order, amountGross)) {
    console.warn('PayFast ITN amount mismatch order', mPaymentId, 'expected', order.finalPrice, 'got', amountGross);
    return res.status(200).send('');
  }

  const result = await fulfillGatewayPayment(mPaymentId, amountGross);
  if (!result.ok && !result.alreadyPaid) {
    console.error('PayFast fulfillment failed:', result.error);
  } else {
    console.log('✅ PayFast ITN processed for order', mPaymentId);
  }

  return res.status(200).send('');
}));

module.exports = router;
