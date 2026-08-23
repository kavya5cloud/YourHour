/**
 * The Hour -- client.
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
  minBidCents: 100,
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
    // Take the first character for the badge without assuming it is ASCII.
    const initial = [...owner.name.trim()][0] ?? '✦';
    setText($('owner-logo'), initial);
  } else {
    setText($('owner-name'), 'Open hour');
    setText(
      $('owner-line'),
      currentHour.status === 'awaiting_payment'
        ? 'The winning bidder is completing checkout.'
        : 'Nobody claimed this hour.',
    );
    setText($('owner-paid'), '');
    setText($('owner-logo'), '✦');
  }

  const endsAt = new Date(currentHour.endsAt);
  state.currentEndsAt = endsAt.getTime();
  state.hourStartedAt = state.currentEndsAt - 3_600_000;
  setText(
    $('expiry'),
    `Ends ${endsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
  );
}

function renderLead(data) {
  const lead = data.nextHour.lead;
  state.minBidCents = data.nextHour.minBidCents;

  setText($('leader-name'), lead ? lead.name : 'No bids yet');
  setText($('leader-bid'), lead ? money(lead.amountCents) : money(state.minBidCents));

  const amount = $('amount');
  // Do not fight the user for the field they are currently typing in.
  if (amount && document.activeElement !== amount) {
    amount.value = String(Math.ceil(state.minBidCents / 100));
  }
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
    renderLead(data);
    renderArchive(data);
    tickClock();
  } catch {
    // A failed poll is not worth interrupting the page for; the next one is a
    // few seconds away.
  }
}

async function loadAccount() {
  try {
    const me = await api('/api/auth/me');
    state.signedIn = Boolean(me.signedIn);
    state.csrfToken = me.csrfToken ?? null;

    $('bid-form').hidden = !state.signedIn;
    $('signin-form').hidden = state.signedIn;
    $('signout').hidden = !state.signedIn;
    setText($('account-line'), state.signedIn ? `Signed in as ${me.email}` : 'Sign in to place a bid.');
  } catch {
    state.signedIn = false;
  }
}

// ------------------------------------------------------------------ events

$('message')?.addEventListener('input', (event) => {
  setText($('count'), `${event.target.value.length} / 90`);
});

$('signin-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const message = $('signin-message');
  button.disabled = true;
  try {
    const result = await api('/api/auth/request-link', {
      method: 'POST',
      body: { email: $('signin-email').value },
    });
    setText(message, result.message);
  } catch (error) {
    setText(message, error.message);
  } finally {
    button.disabled = false;
  }
});

$('bid-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('form-message');
  const button = $('bid-submit');
  setText(message, '');

  // Client-side checks for responsiveness only. The server repeats all of them.
  const name = $('name').value.trim();
  if (!name) {
    setText(message, 'Add a name or link first.');
    $('name').focus();
    return;
  }
  const dollars = Number.parseInt($('amount').value, 10);
  if (!Number.isInteger(dollars) || dollars <= 0) {
    setText(message, 'Enter a whole-dollar bid.');
    $('amount').focus();
    return;
  }

  button.disabled = true;
  try {
    const result = await api('/api/bids', {
      method: 'POST',
      body: {
        amount: dollars,
        name,
        message: $('message').value,
        link: $('link').value,
      },
    });

    setText(message, result.message);
    showReceipt(result);
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      // The session expired while the page was open.
      setText(message, 'Your session expired. Sign in again to bid.');
      await loadAccount();
    } else {
      setText(message, error.message);
    }
  } finally {
    button.disabled = false;
  }
});

function showReceipt(result) {
  setText($('slip-name'), result.listing.name);
  setText($('slip-bid'), money(result.amountCents));
  setText($('slip-hour'), `Hour ${result.hour}`);
  setText($('slip-number'), `#${result.hour}`);
  $('bid-slip').classList.add('visible');

  setText($('ticket-hour'), `Hour ${result.hour}`);
  setText($('ticket-bid'), money(result.amountCents));
  setText($('ticket-name'), result.listing.name);
  setText($('ticket-time'), new Date(serverNow()).toLocaleString());
  $('confirmation').showModal();

  $('bid-form').reset();
  setText($('count'), '0 / 90');
}

$('confirm-bid')?.addEventListener('click', () => $('confirmation').close());
$('confirmation')?.addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
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
    ok: 'Signed in. You can bid now.',
    expired: 'That sign-in link has expired or was already used. Request a new one.',
    invalid: 'That sign-in link was not valid.',
    throttled: 'Too many sign-in attempts. Try again in a little while.',
  };
  setText($('signin-message'), messages[outcome] ?? '');
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
