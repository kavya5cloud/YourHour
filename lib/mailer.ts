/**
 * Transactional email via Resend.
 *
 * All interpolated values are HTML-escaped before they reach the template. A
 * bidder controls their own display name, and that name appears in the winner
 * email, so unescaped interpolation here would be an HTML-injection hole
 * pointed at the recipient's mail client.
 */
import { env } from './env.ts';

/** Escape the five characters that matter in HTML text and attribute context. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Email {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function send(email: Email): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.email.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    // Log status only. The response body can echo the recipient address, and
    // the request carried an API key we must never surface.
    console.error('email send failed', { status: response.status });
    throw new Error('Email delivery failed');
  }
}

const shell = (body: string) => `<!doctype html><html><body style="font-family:ui-monospace,Menlo,monospace;background:#dfe3dc;padding:24px;color:#151815">
<div style="max-width:480px;margin:auto;background:#f0f3ee;border:1px solid #151815;padding:24px">
<div style="font-family:Inter,system-ui,sans-serif;font-weight:900;letter-spacing:-.06em;text-transform:uppercase;font-size:19px;margin-bottom:16px">GetYourHour</div>
${body}
</div></body></html>`;

export async function sendLoginLink(to: string, url: string): Promise<void> {
  const safeUrl = escapeHtml(url);
  await send({
    to,
    subject: 'Your sign-in link for GetYourHour',
    html: shell(
      `<p>Here is your sign-in link. It works once and expires in 15 minutes.</p>
       <p><a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#151815;color:#f0f3ee;text-decoration:none">Sign in</a></p>
       <p style="font-size:12px;color:#687069">If you did not request this, you can ignore this email. Nobody can sign in without opening the link.</p>`,
    ),
    text: `Sign in to GetYourHour: ${url}\n\nThis link works once and expires in 15 minutes. If you did not request it, ignore this email.`,
  });
}
