# The Hour

A single-spot hourly auction prototype. The current owner gets the homepage
for an hour; the next hour is open for bids.

## Prototype flow

- Bids are saved without charging a payment method.
- When the hour rolls over, the highest bidder receives a Polar checkout link.
- The winner has five minutes to complete payment.
- Fifty percent of net proceeds from paid winning hours is intended for charity.

The prototype is self-contained in `index.html`; open it directly in a browser.
It uses simulated bidding and checkout states only—no live payments are wired.
