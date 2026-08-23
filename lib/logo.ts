/**
 * Deriving a listing logo from the listing's link.
 *
 * A bidder should not have to find and upload an image; their site already has
 * an icon. This fetches it once, at bid time, and stores it as a data: URI on
 * the bid -- the same representation an uploaded logo gets, so everything
 * downstream (moderation, the public state, the CSP) is unchanged.
 *
 * The fetch goes to Google's favicon service rather than to the bidder's own
 * host. That is deliberate: fetching a user-supplied URL from our own server is
 * a server-side request forgery primitive -- it would let a bidder point us at
 * `http://169.254.169.254/` or a host on our private network and use our
 * response as an oracle. Here the URL we request is fixed and only the domain
 * is user input, so there is no address a bidder can steer us to.
 *
 * Failure is never fatal. A logo is decoration; a bid is money. If the lookup
 * is slow, blocked, or returns something that is not an image, the bid still
 * goes through with no logo.
 */
import { validateLogo } from './validate.ts';

const LOOKUP_TIMEOUT_MS = 3_000;
const MAX_BYTES = 24_000;

/** Sniff the type from the bytes; the served content-type is not trusted. */
function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Best-effort icon for `linkUrl`. Returns a validated data: URI, or null.
 */
export async function fetchLogoForLink(linkUrl: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(linkUrl).hostname;
  } catch {
    return null;
  }
  if (host === '' || !host.includes('.')) return null;

  try {
    const response = await fetch(
      `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(host)}`,
      { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), redirect: 'follow' },
    );
    if (!response.ok) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;

    const type = sniffImageType(bytes);
    if (!type) return null;

    // Run it through the same validator an uploaded logo faces, so there is
    // exactly one definition of what may be stored.
    return validateLogo(`data:${type};base64,${bytes.toString('base64')}`);
  } catch {
    // Timeout, network failure, or an unusable response. Not worth failing a bid.
    return null;
  }
}
