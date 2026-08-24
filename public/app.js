/**
 * GetYourHour -- client.
 *
 * Ground rules held throughout this file:
 *
 *  - Nothing is written to the DOM as markup. Every piece of server or user
 *    data lands via `textContent` or a created element, so a listing that
 *    contains "<img onerror=...>" is displayed as those literal characters and
 *    can never execute. The CSP is the backstop; this is the actual fix.
 *
 *  - The clock is drawn from the server's time, not the device's. `serverTime`
 *    in each poll gives us an offset, so a visitor with a skewed system clock
 *    still sees the real deadline.
 *
 *  - The page never decides anything that matters. Whether a bid is valid, who
 *    leads, and whether an hour is paid for are all answered by the server; the
 *    validation here exists to give fast feedback, not to gate anything.
 */

const $ = (id) => document.getElementById(id);

const state = {
  csrfToken: null,
  signedIn: false,
  /** serverNow - clientNow, in ms. Applied to every countdown. */
  clockOffset: 0,
  currentEndsAt: 0,
  hourStartedAt: 0,
  polling: null,
};

const money = (cents) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const serverNow = () => Date.now() + state.clockOffset;

/** Replace an element's children with plain text. Never assigns HTML. */
function setText(element, value) {
  if (element) element.textContent = value;
}

// ----------------------------------------------------------------- network

/**
 * Same-origin JSON fetch.
 *
 * `credentials: 'same-origin'` sends the session cookie to our own API only.
 * The CSRF token goes in a header, which a cross-origin page cannot set on a
 * simple request without passing a preflight we do not answer.
 */
async function api(path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrfToken && options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = state.csrfToken;
  }

  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = new Error(payload?.message ?? 'Something went wrong. Try again.');
    error.code = payload?.error ?? 'error';
    error.status = response.status;
    throw error;
  }
  return payload;
}

// ------------------------------------------------------------------ render

function renderOwner(data) {
  const { currentHour } = data;
  setText($('current-label'), `Hour ${currentHour.id}`);

  const owner = currentHour.owner;
  if (owner) {
    setText($('owner-name'), owner.name);
    setText($('owner-line'), owner.tagline);
    setText($('owner-paid'), `Paid ${money(owner.paidCents)}`);
    // A logo if the winner supplied one, otherwise the first character of the
    // name as a badge -- taken with a spread so non-ASCII names are not cut in
    // half through a surrogate pair.
    showOwnerLogo(owner.logo, [...owner.name.trim()][0] ?? '✦');
  } else {
    setText($('owner-name'), 'Open hour');
    setText(
      $('owner-line'),
      currentHour.status === 'awaiting_payment'
        ? 'The winning bidder is completing checkout.'
        : 'Nobody claimed this hour.',
    );
    setText($('owner-paid'), '');
    showOwnerLogo(null, '✦');
  }

  const endsAt = new Date(currentHour.endsAt);
  state.currentEndsAt = endsAt.getTime();
  state.hourStartedAt = state.currentEndsAt - 3_600_000;
  setText(
    $('expiry'),
    `Ends ${endsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
  );
}

/**
 * Swap the owner badge between an image and a letter.
 *
 * `logo` is a data: URI the server has already validated and re-encoded, and
 * the CSP allows `img-src data:`. It is set as an attribute on an <img>, never
 * interpolated into markup, so nothing here can become an injection point.
 */
function showOwnerLogo(logo, fallbackInitial) {
  const image = $('owner-logo-img');
  const letter = $('owner-logo');
  if (logo) {
    image.src = logo;
    image.hidden = false;
    letter.hidden = true;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    letter.hidden = false;
    setText(letter, fallbackInitial);
  }
}

/**
 * The running order.
 *
 * Rendered straight from the server's projection, never computed here: who airs
 * next depends on every other purchase, which the browser cannot know. It is
 * provisional by nature -- a bigger payer arriving reorders everything below
 * the hour that is currently on air.
 */
function renderQueue(data) {
  const list = $('queue');
  list.replaceChildren();

  if (data.queue.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'queue-empty';
    empty.textContent = 'Nobody waiting — pay anything to go next.';
    list.append(empty);
  } else {
    for (const entry of data.queue) {
      const row = document.createElement('div');
      row.className = 'queue-row';
      const position = document.createElement('span');
      position.className = 'queue-pos';
      position.textContent = entry.position === 1 ? 'Next' : `#${entry.position}`;
      const name = document.createElement('b');
      name.textContent = entry.name;
      const paid = document.createElement('span');
      paid.className = 'queue-paid';
      paid.textContent = money(entry.amountCents);
      row.append(position, name, paid);
      list.append(row);
    }
  }

  setText(
    $('front-hint'),
    data.queue.length === 0
      ? 'any amount goes next'
      : `${money(data.frontOfQueueCents)} to go first`,
  );
}

function renderArchive(data) {
  const container = $('archive');
  if (!container) return;
  container.replaceChildren();

  for (const entry of data.archive) {
    const row = document.createElement('div');
    row.className = 'archive-row';

    const time = document.createElement('time');
    time.textContent = `Hour ${entry.hour}`;

    const name = document.createElement('b');
    name.textContent = entry.name;

    const amount = document.createElement('span');
    amount.textContent = money(entry.amountCents);

    row.append(time, name, amount);
    container.append(row);
  }

  setText($('archive-count'), `${data.totals.hoursSold} hours sold`);
  setText($('total-raised'), money(data.totals.raisedCents));
  setText($('highest-hour'), money(data.totals.highestCents));
}

function tickClock() {
  const remaining = Math.max(0, state.currentEndsAt - serverNow());
  const seconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(seconds / 60);

  const clock = $('clock');
  setText(clock, `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
  clock?.classList.toggle('urgent', seconds <= 30 && seconds > 0);

  const span = state.currentEndsAt - state.hourStartedAt;
  const bar = $('time-bar');
  if (bar && span > 0) {
    bar.style.transform = `scaleX(${Math.max(0.015, remaining / span)})`;
  }
}

// ------------------------------------------------------------------- state

async function refresh() {
  try {
    const data = await api('/api/state');
    state.clockOffset = new Date(data.serverTime).getTime() - Date.now();
    renderOwner(data);
    renderQueue(data);
    renderArchive(data);
    tickClock();
  } catch {
    // A failed poll is not worth interrupting the page for; the next one is a
    // few seconds away.
  }
}

/**
 * Find out whether this visitor already has a session.
 *
 * This only decides whether to show the email field -- it never gates the form.
 * A returning bidder does not retype their address; a first-time one just fills
 * it in. If the check fails for any reason, we show the email field, which is
 * the version that works for everyone.
 */
/**
 * Find out whether we already know how to reach this visitor.
 *
 * This only decides whether the email step appears after they press Place bid.
 * It never gates the form. If the check fails, we assume we do not know them,
 * which is the version that works for everyone.
 */
async function loadAccount() {
  try {
    const me = await api('/api/auth/me');
    state.signedIn = Boolean(me.signedIn);
    state.csrfToken = me.csrfToken ?? null;
    $('signout').hidden = !state.signedIn;
    setText($('account-line'), state.signedIn ? `Bidding as ${me.email}` : 'One page, one owner, one hour.');
  } catch {
    state.signedIn = false;
    state.csrfToken = null;
    $('signout').hidden = true;
    setText($('account-line'), 'One page, one owner, one hour.');
  }
}

// ------------------------------------------------------------------ events

$('message')?.addEventListener('input', (event) => {
  setText($('count'), `${event.target.value.length} / 90`);
});

/**
 * Logo picking.
 *
 * The image is squared and shrunk to a small canvas here, in the browser,
 * before it is ever sent: it keeps a 4MB phone photo from becoming a 4MB
 * request, and it means what the server stores is bounded by construction
 * rather than by hoping the buyer picked a sensible file. The server still
 * re-validates the bytes -- this is a convenience, not a trust boundary.
 *
 * Leaving it empty is the normal path: the server fetches the icon for the
 * link instead. This only exists to override that.
 */
const LOGO_PX = 96;
const LOGO_MAX_CHARS = 32_768;
let logoDataUrl = null;

async function squareToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = LOGO_PX;
  canvas.height = LOGO_PX;
  const context = canvas.getContext('2d');
  // Centre-crop to a square so nothing is stretched out of proportion.
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  context.drawImage(bitmap, sx, sy, side, side, 0, 0, LOGO_PX, LOGO_PX);
  bitmap.close?.();

  // WebP where it is supported, PNG otherwise. toDataURL silently falls back
  // to PNG for an unknown type, so check what actually came back.
  for (const [type, quality] of [['image/webp', 0.85], ['image/png', undefined]]) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type};base64,`) && url.length <= LOGO_MAX_CHARS) return url;
  }
  return null;
}

function clearLogo() {
  logoDataUrl = null;
  $('logo').value = '';
  $('logo-preview').removeAttribute('src');
  $('logo-preview').hidden = true;
  $('logo-placeholder').hidden = false;
  $('logo-clear').hidden = true;
}

$('logo')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  const note = $('logo-note');
  if (!file) {
    clearLogo();
    return;
  }
  // Reject the obviously-too-big before decoding it into memory.
  if (file.size > 8_000_000) {
    clearLogo();
    setText(note, 'That image is too large. Pick one under 8MB.');
    return;
  }
  try {
    const url = await squareToDataUrl(file);
    if (!url) {
      clearLogo();
      setText(note, 'That image could not be shrunk small enough.');
      return;
    }
    logoDataUrl = url;
    $('logo-preview').src = url;
    $('logo-preview').hidden = false;
    $('logo-placeholder').hidden = true;
    $('logo-clear').hidden = false;
    setText(note, 'Looks good.');
  } catch {
    clearLogo();
    setText(note, 'That file could not be read as an image.');
  }
});

$('logo-clear')?.addEventListener('click', () => {
  clearLogo();
  setText($('logo-note'), "We'll use your site's icon if you skip this.");
});

/**
 * Opening the form.
 *
 * The fields live in a dialog rather than on the page: everything a visitor
 * needs to decide -- who is on air, who is next, what it costs to jump the
 * front -- fits above the fold without a form competing for attention, and the
 * form only appears once they have decided to buy.
 */
function openBuy() {
  setText($('form-message'), '');
  $('buy').showModal();
  $('name').focus();
}

$('open-buy')?.addEventListener('click', openBuy);
$('buy-cancel')?.addEventListener('click', () => $('buy').close());
// Clicking the backdrop, but not the card itself, dismisses it.
$('buy')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});

/**
 * Buy a slot.
 *
 * On success the server has recorded the purchase and opened a Polar checkout,
 * and all that is left is to send the buyer there. Nothing is held until they
 * actually pay: the purchase joins the running order only when the signed
 * webhook confirms it.
 */
$('claim-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('form-message');
  const button = $('claim-submit');
  setText(message, '');

  const amount = Number.parseInt($('amount').value, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    setText(message, 'Enter a whole-dollar amount.');
    $('amount').focus();
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  setText(button, 'Opening checkout…');
  try {
    const result = await api('/api/claim', {
      method: 'POST',
      body: {
        amount,
        name: $('name').value.trim(),
        link: $('link').value,
        message: $('message').value,
        logo: logoDataUrl,
        email: $('email').value.trim(),
      },
    });
    // Hand off to Polar. The hour is held until they finish or time out.
    window.location.href = result.checkoutUrl;
  } catch (error) {
    setText(message, error.message);
    button.disabled = false;
    setText(button, original);
  }
});


$('signout')?.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Fall through: reloading re-reads the real state either way.
  }
  window.location.reload();
});

/** Surface the outcome of a magic-link click, then clean the URL. */
function reportSignInResult() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('signin');
  if (!outcome) return;

  const messages = {
    ok: 'Email confirmed. Your bid limit is lifted.',
    expired: 'That link has expired or was already used. Bid again to get a new one.',
    invalid: 'That link was not valid.',
    throttled: 'Too many attempts. Try again in a little while.',
  };
  setText($('form-message'), messages[outcome] ?? '');
  // Strip the parameter so a refresh does not repeat the message.
  window.history.replaceState({}, '', window.location.pathname);
}

// -------------------------------------------------------------- lifecycle

reportSignInResult();
await loadAccount();
await refresh();

setInterval(tickClock, 500);

/** Poll for auction changes, but not while the tab is in the background. */
function startPolling() {
  stopPolling();
  state.polling = setInterval(refresh, 5000);
}
function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    void refresh();
    startPolling();
  }
});
startPolling();
