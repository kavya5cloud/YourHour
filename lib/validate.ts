/**
 * Validation and normalisation of everything a user can submit.
 *
 * This module is the trust boundary for listing content. A winning bid's name
 * and tagline get shown on the homepage to every visitor, which makes them a
 * stored-XSS target and a brand-impersonation target at the same time. The
 * approach is allowlist-first: normalise to NFC, strip the character classes
 * that exist mainly to deceive (control, bidi-override, zero-width), cap the
 * length, then require the result to still contain something legible.
 *
 * Output escaping still happens at render time -- this is one layer, not the
 * only one.
 */
import { badRequest } from './http.ts';
import { env } from './env.ts';

/**
 * Characters removed outright:
 *  - C0/C1 control codes
 *  - zero-width space/joiner marks, directional marks, and the BOM
 *  - bidirectional overrides and isolates, which can make a right-to-left
 *    string render as a completely different domain than the one stored
 *  - line and paragraph separators
 */
const STRIP_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/**
 * Characters that separate words rather than hide. These become a space instead
 * of being deleted: dropping them outright would turn "two\nlines" into
 * "twolines" and silently corrupt the text a bidder submitted.
 */
const BREAK_PATTERN = /[\u0009-\u000D\u0085\u2028\u2029]/gu;

/** Normalise a free-text field to a single trimmed line. */
export function cleanText(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw badRequest(`${field} must be text.`);
  // Cap before doing per-character work so a huge string cannot burn CPU.
  const capped = raw.slice(0, 4096);
  return capped
    .normalize('NFC')
    // Word separators first, so they survive as spaces...
    .replace(BREAK_PATTERN, ' ')
    // ...then the genuinely invisible characters are removed outright.
    .replace(STRIP_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** True when the string contains at least one letter, number, or symbol. */
function hasSubstance(value: string): boolean {
  return /[\p{L}\p{N}\p{S}]/u.test(value);
}

export function validateDisplayName(raw: unknown): string {
  const value = cleanText(raw, 'Name');
  if (value.length === 0) throw badRequest('Add a name or link first.', 'name_required');
  if (value.length > 24) throw badRequest('Name must be 24 characters or fewer.', 'name_too_long');
  if (!hasSubstance(value)) throw badRequest('That name needs readable characters.', 'name_invalid');
  return value;
}

export function validateTagline(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  const value = cleanText(raw, 'Message');
  if (value.length > 90) throw badRequest('Message must be 90 characters or fewer.', 'tagline_too_long');
  if (value.length > 0 && !hasSubstance(value)) {
    throw badRequest('That message needs readable characters.', 'tagline_invalid');
  }
  return value;
}

/**
 * Email validation.
 *
 * Kept deliberately conservative rather than RFC-exhaustive: the address has to
 * survive a round trip through a mail provider anyway, so the useful checks are
 * length, a single @, no whitespace or control characters, and a dotted domain.
 */
export function validateEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Enter an email address.', 'email_required');
  const value = raw.slice(0, 320).normalize('NFC').replace(STRIP_PATTERN, '').trim().toLowerCase();
  if (value.length === 0) throw badRequest('Enter an email address.', 'email_required');
  if (value.length > 254) throw badRequest('That email address is too long.', 'email_invalid');
  const parts = value.split('@');
  if (parts.length !== 2) throw badRequest('Enter a valid email address.', 'email_invalid');
  const [local, domain] = parts as [string, string];
  if (local.length === 0 || local.length > 64) throw badRequest('Enter a valid email address.', 'email_invalid');
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    throw badRequest('Enter a valid email address.', 'email_invalid');
  }
  if (!/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw badRequest('Enter a valid email address.', 'email_invalid');
  }
  return value;
}

/**
 * Optional outbound link on a listing.
 *
 * Only http(s) is accepted -- `javascript:`, `data:`, and `vbscript:` are the
 * classic ways a "link" becomes script execution. Embedded credentials are
 * rejected because they are almost always a phishing construction.
 */
export function validateLinkUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest('Link must be text.', 'link_invalid');
  const value = cleanText(raw, 'Link');
  if (value.length === 0) return null;
  if (value.length > 200) throw badRequest('That link is too long.', 'link_too_long');

  let url: URL;
  try {
    // Bare domains are common input; assume https rather than guessing a scheme.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    throw badRequest('That does not look like a valid link.', 'link_invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Links must start with http or https.', 'link_scheme');
  }
  if (url.username !== '' || url.password !== '') {
    throw badRequest('Links cannot contain credentials.', 'link_invalid');
  }
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw badRequest('That does not look like a valid link.', 'link_invalid');
  }
  return url.toString();
}

/**
 * Bid amount, submitted in whole dollars and stored in cents.
 *
 * Accepting only an integer number of dollars keeps float rounding out of the
 * money path entirely.
 */
export function validateBidDollars(raw: unknown): number {
  let dollars: number;
  if (typeof raw === 'number') {
    dollars = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim().replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d{1,9}$/.test(trimmed)) throw badRequest('Enter a whole-dollar bid.', 'amount_invalid');
    dollars = Number.parseInt(trimmed, 10);
  } else {
    throw badRequest('Enter a whole-dollar bid.', 'amount_invalid');
  }
  if (!Number.isInteger(dollars) || dollars <= 0) throw badRequest('Enter a whole-dollar bid.', 'amount_invalid');

  const cents = dollars * 100;
  if (cents < env.auction.minBidCents) {
    throw badRequest(`Bids start at ${formatMoney(env.auction.minBidCents)}.`, 'amount_too_low');
  }
  if (cents > env.auction.maxBidCents) {
    throw badRequest(`Bids are capped at ${formatMoney(env.auction.maxBidCents)}.`, 'amount_too_high');
  }
  return cents;
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** UUID check for body identifiers, so malformed ids never reach the database. */
export function validateUuid(raw: unknown, field = 'id'): string {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof raw !== 'string' || !pattern.test(raw)) {
    throw badRequest(`Invalid ${field}.`, 'invalid_id');
  }
  return raw.toLowerCase();
}
