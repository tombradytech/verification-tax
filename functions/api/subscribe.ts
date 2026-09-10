/**
 * Cloudflare Pages Function: POST /api/subscribe
 *
 * Proxies a single email address to Buttondown so the API key never reaches the
 * browser. The contract that matters: this endpoint returns a 2xx ONLY when
 * Buttondown has confirmed the write. Anything else is a 5xx, and the page shows
 * a failure. There is no path through this file that reports success for a write
 * that did not happen.
 */

interface Env {
  /** Buttondown API key. Set in the Cloudflare dashboard, never in the repo. */
  BUTTONDOWN_API_KEY: string;
}

const BUTTONDOWN_ENDPOINT = 'https://api.buttondown.email/v1/subscribers';

/** Deliberately loose. Real validation is Buttondown's job; this rejects junk. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const redirect = (origin: string, path: string) =>
  new Response(null, { status: 303, headers: { location: `${origin}${path}`, 'cache-control': 'no-store' } });

const handlePost: PagesFunction<Env> = async ({ request, env }) => {
  const origin = new URL(request.url).origin;
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const fail = (status: number, message: string) =>
    wantsJson ? json({ ok: false, error: message }, status) : redirect(origin, '/subscribe-failed');
  const succeed = () =>
    wantsJson ? json({ ok: true }, 200) : redirect(origin, '/subscribed');

  let email = '';
  let honeypot = '';

  try {
    const type = request.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      email = String(body.email ?? '').trim();
      honeypot = String(body.company_website ?? '').trim();
    } else {
      const form = await request.formData();
      email = String(form.get('email') ?? '').trim();
      honeypot = String(form.get('company_website') ?? '').trim();
    }
  } catch {
    return fail(400, 'Could not read that request.');
  }

  // A bot filled the hidden field. Answer as though it worked; store nothing.
  if (honeypot) return succeed();

  if (!EMAIL.test(email) || email.length > 254) {
    return fail(400, 'That does not look like an email address.');
  }

  if (!env.BUTTONDOWN_API_KEY) {
    // Misconfiguration is a failure, not a silent drop.
    return fail(500, 'The signup service is not configured.');
  }

  let upstream: Response;
  try {
    upstream = await fetch(BUTTONDOWN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.BUTTONDOWN_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ email_address: email, tags: ['aggregate-report'] })
    });
  } catch {
    return fail(502, 'Could not reach the signup service.');
  }

  if (upstream.ok) return succeed();

  // Already on the list is the user's desired end state, so treat it as done.
  if (upstream.status === 400) {
    const text = await upstream.text();
    if (/already\s+(subscribed|exists)|duplicate/i.test(text)) return succeed();
    return fail(400, 'That address was rejected.');
  }

  return fail(502, 'The signup service returned an error.');
};

/**
 * Single entry point. Method-specific exports plus a catch-all `onRequest` in one
 * module is ambiguous in Pages Functions, so route by hand.
 */
export const onRequest: PagesFunction<Env> = async (context) => {
  const { method } = context.request;
  if (method === 'POST') return handlePost(context);
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
  }
  // Keeps GET /api/subscribe from looking like a broken route.
  return new Response('Send a POST with an email address.', {
    status: 405,
    headers: { allow: 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8' }
  });
};
