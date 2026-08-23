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
  /** The hour the visitor has picked off the board, if any. */
  chosenHour: null,
  /** The last state payload, so the submit button can be re-synced on click. */
  lastState: null,
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
  setText($('next-label'), `Hour ${data.nextHour.id}`);

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
 * The board of hours on sale.
 *
 * Rendered from the server's `board`, never computed here: the price of an hour
 * and whether it is still free are both decisions the server owns, and a page
 * that guessed them would show someone a price they cannot actually pay.
 */
function renderBoard(data) {
  const board = $('board');
  const chosen = state.chosenHour;
  board.replaceChildren();

  for (const slot of data.board) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot';
    button.setAttribute('role', 'radio');
    button.dataset.hour = String(slot.hour);
    button.disabled = slot.taken;
    button.setAttribute('aria-checked', String(slot.hour === chosen));
    if (slot.hour === chosen) button.classList.add('chosen');
    if (slot.taken) button.classList.add('taken');

    const when = document.createElement('b');
    when.textContent = new Date(slot.startsAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    const price = document.createElement('span');
    price.textContent = slot.taken ? 'Taken' : money(slot.priceCents);
    button.append(when, price);
    board.append(button);
  }

  // A chosen hour that someone else just bought has to be given up.
  if (chosen && !data.board.some((slot) => slot.hour === chosen && !slot.taken)) {
    state.chosenHour = null;
    setText($('form-message'), 'That hour was just taken. Pick another.');
  }
  syncClaimButton(data);
}

/** Keep the submit button's label and enabled state tied to the chosen hour. */
function syncClaimButton(data) {
  const button = $('claim-submit');
  const slot = data?.board.find((entry) => entry.hour === state.chosenHour);
  if (!slot) {
    button.disabled = true;
    setText(button, 'Pick an hour first');
    return;
  }
  button.disabled = false;
  setText(button, `Claim this hour — ${money(slot.priceCents)}`);
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
    state.lastState = data;
    renderOwner(data);
    renderBoard(data);
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
 * Choosing an hour.
 *
 * Delegated from the board container so it keeps working across re-renders --
 * the board is rebuilt on every poll, and per-button listeners would be lost.
 */
$('board')?.addEventListener('click', (event) => {
  const button = event.target.closest('.slot');
  if (!button || button.disabled) return;
  state.chosenHour = Number(button.dataset.hour);
  setText($('form-message'), '');
  for (const slot of $('board').querySelectorAll('.slot')) {
    const chosen = slot === button;
    slot.classList.toggle('chosen', chosen);
    slot.setAttribute('aria-checked', String(chosen));
  }
  syncClaimButton(state.lastState);
});

/**
 * Claim the chosen hour.
 *
 * On success the server has reserved the hour and opened a Polar checkout, and
 * the only thing left is to send the buyer there. Everything after that point
 * -- taking the money, confirming the hour -- happens through the signed
 * webhook, never through the browser coming back to a success URL.
 */
$('claim-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('form-message');
  const button = $('claim-submit');
  setText(message, '');

  if (!state.chosenHour) {
    setText(message, 'Pick an hour first.');
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  setText(button, 'Opening checkout…');
  try {
    const result = await api('/api/claim', {
      method: 'POST',
      body: {
        hourId: state.chosenHour,
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
    // A taken hour means the board is stale; refresh it so they can see what
    // is actually still free.
    void refresh();
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
