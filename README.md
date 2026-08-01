# Lifecycle Mail Sim

A dry-run simulator for lifecycle email orchestration. Import your contacts, configure the
campaigns you're running (promo, invite, nurture, newsletter, payment reminder, renewal), and
simulate a date — the tool tells you exactly which email each contact would get today, in what
order, and why, plus every place a contact would get suppressed or collide with another campaign.
Nothing sends. It's a sandbox for answering "what happens if I turn this on" before you actually
turn it on.

## Who it's for

Lifecycle and marketing ops folks running multiple concurrent email programs across HubSpot,
Marketo, Customer.io, Braze, or similar, who want to sanity-check "for this contact today, what
fires, in what order, and does anything conflict" before flipping campaigns live — instead of
finding out from a support ticket that someone got three emails in one day, or a payment reminder
after the invoice was already paid.

## How to open it

No build step, no install, no server required.

1. Download or clone this folder.
2. Open `index.html` directly in a browser (double-click it, or `open index.html` on macOS).

If your browser blocks local file access for some reason, any static file server works too, e.g.
from this directory: `python3 -m http.server 8080` and then visit `http://localhost:8080/`.

The app makes zero network calls — everything, including the sample dataset, is bundled in the
page. It only reads/writes files you explicitly choose (CSV import, CSV export).

## Walkthrough: the sample-data demo

Click **Load Sample Data** in the top bar (or on the empty-state screen). This instantly loads:

- **20 sample contacts** with a deliberate mix of lifecycle stages, plans, payment statuses,
  unsubscribe flags, and send histories.
- **6 pre-built campaigns**, one per supported type (invite, nurture, promo, newsletter, payment
  reminder, renewal), each with its own flat AND-only conditions, frequency cap, and priority.
- A **simulation is run automatically** for 2026-07-30 (the dataset's reference date) so you see
  results immediately, with zero clicks beyond "Load Sample Data."

In the results you'll see, among other things:

- **A suppression block** — contact `C003` matches the "New Lead Welcome Invite" campaign but is
  unsubscribed, so it's blocked with rule `unsubscribed`. Contacts `C014` and `C018` show the same
  rule firing on different campaigns.
- **An already-paid block** — contact `C008` matches "Renewal Payment Reminder" (customer, renewal
  due soon) but `payment_status` is `paid`, so it's blocked with rule `already_paid`.
- **A frequency-cap block** — contact `C001` matches the invite campaign but already got an email
  4 days before the simulated date, inside the campaign's 14-day cap window, so it's blocked with
  rule `frequency_cap`.
- **Same-day conflicts** — contact `C007` matches four campaigns on the same day (payment
  reminder, renewal notice, promo, and newsletter all fire for the same "pro" plan customer with a
  near-term renewal). All four are shown in priority order with the exact tie-break rule spelled
  out, so you can see precisely why the order is what it is instead of guessing.
- **No-activity contacts** — `C010` and `C011` are shown explicitly with a "no activity" tag so you
  can confirm the simulation actually ran and simply found nothing to send them, rather than being
  silently omitted from the results.

From there, try:

- Expanding any contact row to see its full per-date breakdown (sent / blocked / conflicts).
- Editing a campaign's conditions, cap, or priority and re-running Simulate to see the results
  change.
- Enabling the global daily send cap and re-simulating to see it start blocking additional
  campaigns beyond your configured max-per-day.
- **Copy as CSV** / **Download CSV** on the results panel to get a scannable, spreadsheet-ready
  export instead of scrolling the UI.
- Importing your own CSV (see column schema below) to replace the sample contacts.

## CSV schema

Required columns (case-sensitive, in any order):

| Column | Notes |
|---|---|
| `contact_id` | Any non-empty string; used as the unique key. |
| `lifecycle_stage` | Free text, e.g. `lead`, `trial`, `customer`. |
| `plan` | Free text, e.g. `free`, `pro`, `enterprise`. |
| `renewal_date` | `YYYY-MM-DD` or `MM/DD/YYYY`. Blank is allowed (treated as "no renewal on file"). |
| `payment_status` | Free text, e.g. `paid`, `overdue`, `pending`, `none`. |
| `last_email_sent_date` | Same date formats as above. Seeds the frequency-cap history. |
| `unsubscribed` | `true`/`false`, `yes`/`no`, `1`/`0`. |

Any additional columns are imported as custom fields and become available as condition fields in
the campaign builder (e.g. a `region` column lets you build a condition on `region`).

Malformed rows are never silently dropped:

- A missing `contact_id`, or a row with the wrong number of columns, is **skipped** and counted,
  with the reason shown in an "Import notes" panel.
- An unparseable date or unrecognized `unsubscribed` value is **flagged** (shown in the same
  panel) and the field is treated as missing on that row — the contact itself is still imported.
- A completely empty file, or a file missing one of the required columns, is rejected outright
  with a clear message instead of partially importing.

Two bundled fixture files demonstrate this: `data/sample_contacts.csv` (clean, used by "Load
Sample Data") and `data/sample_contacts_with_errors.csv` (deliberately malformed, useful for
trying the "Import CSV" error path — also exercised directly by the test suite).

## Campaign builder

Each campaign has:

- A **type** — one of the six fixed types (promo, invite, nurture, newsletter, payment_reminder,
  renewal). This is a label used for suppression logic (payment reminders get the "already paid"
  rule) and display; it doesn't change how conditions are evaluated.
- A **flat list of conditions** (`field` + `operator` + `value`), combined with **AND only**. This
  is intentional: there's no nested boolean logic, no OR groups. It keeps every campaign legible
  at a glance and keeps the tool's scope from ballooning into a full expression builder. A
  campaign with zero conditions is rejected at save time (it would otherwise silently match every
  contact).
- A **frequency cap** — max emails per rolling N days, checked against that contact's send history
  (seeded from `last_email_sent_date`, plus anything the simulation itself sends).
- A **priority** — an integer used purely for same-day tie-breaking. Lower numbers send first.
  Ties are explicitly allowed; when two campaigns tie, the tie is broken alphabetically by
  campaign name, and that rule is stated both in the UI and in every conflict callout in the
  results.

## Built-in suppression rules

These four rules always apply, to every campaign, and are not editable (the global cap is the one
opt-in exception):

1. **Unsubscribed** — always suppresses every campaign for that contact.
2. **Already paid** — suppresses `payment_reminder` campaigns specifically when `payment_status`
   is `paid`.
3. **Frequency cap exceeded** — each campaign's own max-per-rolling-N-days cap.
4. **Global daily send cap** (opt-in toggle) — caps total emails per contact per day across every
   campaign, applied in priority order after per-campaign suppression is resolved.

## Methodology notes

- **Same-day ordering** is deterministic and fully disclosed: ascending campaign priority, ties
  broken alphabetically by campaign name. This is a design choice, not a discovery — real ESPs
  don't agree on how they order same-day sends, so this tool picks one explicit, visible rule
  rather than an implicit black-box one.
- **Frequency-cap history** is a simplification. The CSV schema only carries one
  `last_email_sent_date` per contact, not a full send log, so the simulator seeds each contact's
  rolling-window history with that single date and then layers on whatever it sends during the
  simulated range. It cannot see sends that happened before that date, or sends from campaigns
  outside this tool.
- **Dead campaign detection** checks whether a campaign's conditions can match any imported
  contact at all (independent of suppression or the simulated date) and flags it in the results
  panel — useful for catching a typo'd condition value before you wonder why nothing sent.
- **Missing fields never crash the simulation.** A condition referencing a field that's null/blank
  on a given contact is treated as a non-match for that condition (except `is_empty` /
  `is_not_empty`, which exist specifically to test for that case).

## Honest limitations

- **This is a rules model you configure, not a live read of your ESP.** Nothing in this tool talks
  to HubSpot, Marketo, Customer.io, or Braze. You are re-describing your campaigns' triggers,
  caps, and suppression logic by hand inside this UI. The moment someone edits the real campaign
  in the real platform, this simulator's model of it goes stale — there is no sync. Treat results
  as a second opinion to sanity-check your own configuration, not as ground truth about what will
  actually happen.
- **No platform's real frequency-capping, suppression precedence, or same-day dedup behavior is
  guaranteed to match this tool's.** Every ESP implements these differently, and often
  inconsistently or without full documentation. A hand-built rules engine like this one can't
  promise it mirrors any specific platform's actual behavior — it can only be internally
  consistent and clearly explain its own rules (which is what the UI tries hard to do).
- **Conditions are intentionally limited to a flat AND-only list.** There's no OR, no grouping, no
  nested logic. If your real campaign's trigger needs "(A and B) or C," you'll need to model it as
  two separate campaigns with the same priority/type, or approximate it. This is a deliberate
  scope guardrail, not an oversight.
- **All data lives in the browser tab only.** There's no persistence across page reloads and
  nothing is saved to disk automatically — export your campaign setup or results via CSV if you
  want to keep them.

## Development

The simulation engine is a plain, dependency-free JS module (`src/csv.js` + `src/engine.js`),
written as a small UMD wrapper so the exact same code runs under Node (for tests) and in the
browser (via a plain `<script>` tag, no bundler). `src/app.js` is the (browser-only) UI layer that
wires the DOM to that engine; `src/sample-data.js` bundles the demo dataset.

Run the test suite:

```bash
node --test tests/
```

Project layout:

```
index.html              entry point — open this in a browser
css/styles.css           all styling, light/dark aware, no external assets
src/csv.js                CSV parsing, validation, date/boolean normalization
src/engine.js             campaign matching, suppression, simulation, CSV export
src/sample-data.js        bundled sample contacts + 6 pre-built campaigns
src/app.js                DOM wiring / rendering (browser only)
data/sample_contacts.csv               the same sample data as a real CSV file
data/sample_contacts_with_errors.csv   a deliberately malformed fixture for the import-error path
tests/csv.test.js         CSV parsing/validation tests
tests/engine.test.js      matching, suppression, simulation, and sample-dataset tests
```
