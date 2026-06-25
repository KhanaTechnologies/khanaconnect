const DEFAULT_GRACE_DAYS = 7;

function normalizeSubscription(client) {
  const raw = client?.subscription || {};
  return {
    status: raw.status || 'active',
    plan: raw.plan || 'partnership',
    billingCycle: raw.billingCycle || 'monthly',
    paidUntil: raw.paidUntil ? new Date(raw.paidUntil) : null,
    graceUntil: raw.graceUntil ? new Date(raw.graceUntil) : null,
    notes: String(raw.notes || '').trim(),
    lastPaymentAt: raw.lastPaymentAt ? new Date(raw.lastPaymentAt) : null,
    suspendedAt: raw.suspendedAt ? new Date(raw.suspendedAt) : null,
  };
}

function isPlatformAdminClient(client) {
  return client?.role === 'admin';
}

/**
 * Active when: platform admin, or paidUntil in future, or grace period, or legacy client with no paidUntil set.
 */
function isClientSubscriptionActive(client, now = new Date()) {
  if (!client) return false;
  if (isPlatformAdminClient(client)) return true;

  const sub = normalizeSubscription(client);
  if (sub.status === 'suspended' || sub.status === 'canceled') return false;

  if (!sub.paidUntil) {
    return sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due';
  }

  if (sub.paidUntil.getTime() > now.getTime()) return true;
  if (sub.graceUntil && sub.graceUntil.getTime() > now.getTime()) return true;

  return false;
}

function daysUntil(date, now = new Date()) {
  if (!date) return null;
  const ms = new Date(date).getTime() - now.getTime();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function subscriptionDisplayStatus(client, now = new Date()) {
  if (!client) return 'unknown';
  if (isPlatformAdminClient(client)) return 'admin';

  const sub = normalizeSubscription(client);
  if (sub.status === 'suspended') return 'suspended';
  if (sub.status === 'canceled') return 'canceled';

  if (!sub.paidUntil) return 'active';

  const active = isClientSubscriptionActive(client, now);
  if (active) {
    const days = daysUntil(sub.paidUntil, now);
    if (days != null && days <= DEFAULT_GRACE_DAYS && sub.paidUntil <= now) return 'grace';
    if (days != null && days <= 7 && sub.paidUntil > now) return 'expiring_soon';
    return 'active';
  }

  return 'past_due';
}

function serializeSubscriptionSummary(client, now = new Date()) {
  const sub = normalizeSubscription(client);
  const active = isClientSubscriptionActive(client, now);
  const displayStatus = subscriptionDisplayStatus(client, now);
  const daysRemaining = sub.paidUntil ? daysUntil(sub.paidUntil, now) : null;

  return {
    ...sub,
    paidUntil: sub.paidUntil ? sub.paidUntil.toISOString() : null,
    graceUntil: sub.graceUntil ? sub.graceUntil.toISOString() : null,
    lastPaymentAt: sub.lastPaymentAt ? sub.lastPaymentAt.toISOString() : null,
    suspendedAt: sub.suspendedAt ? sub.suspendedAt.toISOString() : null,
    isActive: active,
    displayStatus,
    daysRemaining,
  };
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Number(months));
  return d;
}

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + Number(years));
  return d;
}

function defaultPaidUntilForNewClient(now = new Date()) {
  return addMonths(now, 1);
}

function cycleToMonths(billingCycle) {
  switch (String(billingCycle || '').toLowerCase()) {
    case 'yearly':
    case 'annual':
      return 12;
    case 'quarterly':
      return 3;
    case 'monthly':
    default:
      return 1;
  }
}

function applyGracePeriod(paidUntil, graceDays = DEFAULT_GRACE_DAYS) {
  const end = new Date(paidUntil);
  end.setDate(end.getDate() + Number(graceDays));
  return end;
}

/**
 * Admin subscription updates.
 * Body: { action?: 'set'|'reinstate'|'extend'|'suspend', paidUntil?, billingCycle?, plan?, status?, notes?, extendMonths?, extendYears?, graceDays? }
 */
function applySubscriptionUpdate(client, body = {}) {
  if (!client.subscription || typeof client.subscription !== 'object') {
    client.subscription = {};
  }
  const sub = client.subscription;
  const action = String(body.action || 'set').toLowerCase();
  const now = new Date();

  if (action === 'suspend') {
    sub.status = 'suspended';
    sub.suspendedAt = now;
    if (body.notes != null) sub.notes = String(body.notes).trim();
    return serializeSubscriptionSummary(client, now);
  }

  if (action === 'reinstate' || action === 'extend') {
    const base =
      sub.paidUntil && new Date(sub.paidUntil).getTime() > now.getTime()
        ? new Date(sub.paidUntil)
        : now;

    if (body.paidUntil) {
      sub.paidUntil = new Date(body.paidUntil);
    } else {
      const months = body.extendMonths != null ? Number(body.extendMonths) : cycleToMonths(body.billingCycle || sub.billingCycle);
      const years = body.extendYears != null ? Number(body.extendYears) : 0;
      let next = base;
      if (years > 0) next = addYears(next, years);
      if (months > 0) next = addMonths(next, months);
      sub.paidUntil = next;
    }

    sub.status = 'active';
    sub.lastPaymentAt = now;
    sub.suspendedAt = null;
    if (body.billingCycle) sub.billingCycle = body.billingCycle;
    if (body.plan) sub.plan = body.plan;
    if (body.notes != null) sub.notes = String(body.notes).trim();

    const graceDays = body.graceDays != null ? Number(body.graceDays) : DEFAULT_GRACE_DAYS;
    sub.graceUntil = applyGracePeriod(sub.paidUntil, graceDays);

    return serializeSubscriptionSummary(client, now);
  }

  if (body.status) sub.status = body.status;
  if (body.plan) sub.plan = body.plan;
  if (body.billingCycle) sub.billingCycle = body.billingCycle;
  if (body.notes != null) sub.notes = String(body.notes).trim();
  if (body.paidUntil !== undefined) {
    sub.paidUntil = body.paidUntil ? new Date(body.paidUntil) : null;
    if (sub.paidUntil && body.graceDays != null) {
      sub.graceUntil = applyGracePeriod(sub.paidUntil, Number(body.graceDays));
    } else if (sub.paidUntil && !sub.graceUntil) {
      sub.graceUntil = applyGracePeriod(sub.paidUntil, DEFAULT_GRACE_DAYS);
    }
  }
  if (body.graceUntil !== undefined) {
    sub.graceUntil = body.graceUntil ? new Date(body.graceUntil) : null;
  }

  return serializeSubscriptionSummary(client, now);
}

function subscriptionBlockedResponse(res, client) {
  const summary = serializeSubscriptionSummary(client);
  return res.status(402).json({
    error: 'Subscription inactive. Please renew your Khana partnership to continue.',
    code: 'SUBSCRIPTION_INACTIVE',
    subscription: summary,
  });
}

function assertClientSubscriptionActive(client, res) {
  if (isClientSubscriptionActive(client)) return true;
  subscriptionBlockedResponse(res, client);
  return false;
}

module.exports = {
  DEFAULT_GRACE_DAYS,
  normalizeSubscription,
  isClientSubscriptionActive,
  subscriptionDisplayStatus,
  serializeSubscriptionSummary,
  defaultPaidUntilForNewClient,
  applyGracePeriod,
  applySubscriptionUpdate,
  subscriptionBlockedResponse,
  assertClientSubscriptionActive,
};
