/**
 * Lightweight pre-submit checks so clients catch Meta rejection patterns early.
 * Not a substitute for Meta review — advisory only.
 */

const SUSPICIOUS_PHRASES = [
  /\bfree money\b/i,
  /\bguaranteed\b/i,
  /\bact now\b/i,
  /\blimited time only!!!+\b/i,
  /\bclick here!!!+\b/i,
  /\bcrypto\b/i,
  /\bbitcoin\b/i,
  /\bnudes?\b/i,
];

function countPlaceholders(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(/\{\{(\d+)\}\}/g)) {
    set.add(Number(m[1]));
  }
  return set.size;
}

function maxPlaceholder(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/\{\{(\d+)\}\}/g)) {
    max = Math.max(max, Number(m[1]) || 0);
  }
  return max;
}

/**
 * @param {{
 *   name?: string,
 *   category?: string,
 *   header?: string,
 *   body?: string,
 *   footer?: string,
 *   button_url?: string,
 *   body_examples?: string[],
 * }} draft
 */
function coachWhatsAppTemplate(draft = {}) {
  const issues = [];
  const tips = [];
  const name = String(draft.name || '').trim().toLowerCase();
  const category = String(draft.category || 'UTILITY').trim().toUpperCase();
  const body = String(draft.body || '').trim();
  const header = String(draft.header || '').trim();
  const footer = String(draft.footer || '').trim();
  const buttonUrl = String(draft.button_url || draft.buttonUrl || '').trim();
  const examples = Array.isArray(draft.body_examples)
    ? draft.body_examples
    : String(draft.body_examples || '')
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean);

  if (!name) {
    issues.push({ level: 'error', code: 'name_required', message: 'Add a template name (lowercase_with_underscores).' });
  } else if (!/^[a-z0-9_]+$/.test(name)) {
    issues.push({
      level: 'error',
      code: 'name_format',
      message: 'Name must be lowercase letters, numbers, and underscores only.',
    });
  } else if (name.length > 512) {
    issues.push({ level: 'error', code: 'name_long', message: 'Name is too long for Meta.' });
  }

  if (!body) {
    issues.push({ level: 'error', code: 'body_required', message: 'Message body is required.' });
  } else {
    if (body.length > 1024) {
      issues.push({ level: 'error', code: 'body_long', message: 'Body must be 1024 characters or fewer.' });
    }
    if (/^\{\{\d+\}\}/.test(body)) {
      issues.push({
        level: 'error',
        code: 'body_starts_var',
        message: 'Body cannot start with a variable — add a short greeting first.',
      });
    }
    if (/\{\{\d+\}\}$/.test(body)) {
      issues.push({
        level: 'warn',
        code: 'body_ends_var',
        message: 'Avoid ending the body with only a variable — Meta often rejects that.',
      });
    }
    const max = maxPlaceholder(body);
    const count = countPlaceholders(body);
    if (max !== count) {
      issues.push({
        level: 'error',
        code: 'vars_gap',
        message: `Variables must be sequential ({{1}}…{{${max}}} with no gaps).`,
      });
    }
    if (max > 0 && examples.length < max) {
      issues.push({
        level: 'error',
        code: 'examples_missing',
        message: `Add sample values for {{1}} through {{${max}}} (Meta requires examples).`,
      });
    }
    for (const phrase of SUSPICIOUS_PHRASES) {
      if (phrase.test(body) || phrase.test(header)) {
        issues.push({
          level: 'warn',
          code: 'spammy_phrase',
          message: 'Wording may look spammy to Meta reviewers — soften claims and urgency.',
        });
        break;
      }
    }
  }

  if (header.length > 60) {
    issues.push({ level: 'error', code: 'header_long', message: 'Header must be 60 characters or fewer.' });
  }
  if (footer.length > 60) {
    issues.push({ level: 'error', code: 'footer_long', message: 'Footer must be 60 characters or fewer.' });
  }

  if (category === 'MARKETING') {
    tips.push('Marketing templates need clear opt-in; include an easy opt-out line in the footer when possible.');
  } else if (category === 'UTILITY') {
    tips.push('Utility works best for order/booking updates the customer already expects.');
  }

  if (buttonUrl && !/^https:\/\//i.test(buttonUrl) && !buttonUrl.includes('{{')) {
    issues.push({
      level: 'warn',
      code: 'button_https',
      message: 'Button URLs should use https://',
    });
  }

  if (!issues.some((i) => i.level === 'error')) {
    tips.push('Looks ready to submit. Meta still reviews every template — approval can take minutes to a day.');
  }

  const errorCount = issues.filter((i) => i.level === 'error').length;
  return {
    ok: errorCount === 0,
    score: errorCount === 0 ? (issues.length ? 80 : 100) : Math.max(10, 70 - errorCount * 20),
    issues,
    tips,
  };
}

module.exports = {
  coachWhatsAppTemplate,
  countPlaceholders,
  maxPlaceholder,
};
