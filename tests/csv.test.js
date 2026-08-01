'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var fs = require('node:fs');
var CSV = require(path.join(__dirname, '..', 'src', 'csv.js'));

test('parseCSVText: basic rows and quoted commas', function () {
  var text = 'a,b,c\n1,2,3\n"x,y",z,"w""q"';
  var rows = CSV.parseCSVText(text);
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3'], ['x,y', 'z', 'w"q']]);
});

test('normalizeDate: accepts ISO and US formats', function () {
  assert.equal(CSV.normalizeDate('2026-07-30'), '2026-07-30');
  assert.equal(CSV.normalizeDate('07/30/2026'), '2026-07-30');
  assert.equal(CSV.normalizeDate('7/4/2026'), '2026-07-04');
});

test('normalizeDate: rejects unparseable and impossible dates', function () {
  assert.equal(CSV.normalizeDate('not-a-date'), null);
  assert.equal(CSV.normalizeDate('13/40/2026'), null);
  assert.equal(CSV.normalizeDate('2026-02-30'), null);
  assert.equal(CSV.normalizeDate(''), null);
  assert.equal(CSV.normalizeDate(null), null);
});

test('normalizeBoolean: recognizes common truthy/falsy tokens', function () {
  assert.equal(CSV.normalizeBoolean('true'), true);
  assert.equal(CSV.normalizeBoolean('Yes'), true);
  assert.equal(CSV.normalizeBoolean('0'), false);
  assert.equal(CSV.normalizeBoolean('no'), false);
  assert.equal(CSV.normalizeBoolean('maybe'), null);
});

test('validateContacts: rejects a fully empty file with a clear message', function () {
  var result = CSV.validateContacts('');
  assert.equal(result.fatal, true);
  assert.equal(result.contacts.length, 0);
  assert.match(result.errors[0].reason, /empty/i);
});

test('validateContacts: rejects a file missing required columns', function () {
  var text = 'contact_id,lifecycle_stage\nC1,lead';
  var result = CSV.validateContacts(text);
  assert.equal(result.fatal, true);
  assert.match(result.errors[0].reason, /Missing required column/i);
});

test('validateContacts: valid minimal file with custom field parses cleanly', function () {
  var text = 'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed,region\n' +
    'C1,lead,free,,none,,false,NA';
  var result = CSV.validateContacts(text);
  assert.equal(result.fatal, false);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.contacts[0].custom.region, 'NA');
  assert.deepEqual(result.customFields, ['region']);
});

test('validateContacts: flags malformed rows with a visible count and reason, does not silently drop', function () {
  var text = fs.readFileSync(path.join(__dirname, '..', 'data', 'sample_contacts_with_errors.csv'), 'utf8');
  var result = CSV.validateContacts(text);
  assert.equal(result.fatal, false);

  // E002: bad renewal_date -> row kept, field flagged/treated as missing
  var e002 = result.contacts.find(function (c) { return c.contact_id === 'E002'; });
  assert.ok(e002, 'E002 should still be present as a contact');
  assert.equal(e002.renewal_date, null);

  // row 3 (missing contact_id) -> skipped entirely, not silently: reflected in skippedCount + errors
  assert.ok(result.skippedCount >= 1);
  assert.ok(result.errors.length >= 1);
  assert.ok(result.errors.some(function (e) { return /contact_id/i.test(e.reason); }));

  // E004: bad last_email_sent_date -> flagged, field treated as missing
  var e004 = result.contacts.find(function (c) { return c.contact_id === 'E004'; });
  assert.ok(e004);
  assert.equal(e004.last_email_sent_date, null);

  // E005: unrecognized unsubscribed value -> flagged, treated as true (suppressed) for safety
  var e005 = result.contacts.find(function (c) { return c.contact_id === 'E005'; });
  assert.ok(e005);
  assert.equal(e005.unsubscribed, true);
  assert.ok(result.errors.some(function (e) { return /unsubscribed/i.test(e.reason); }));

  // E006: wrong column count -> skipped entirely
  assert.equal(result.contacts.some(function (c) { return c.contact_id === 'E006'; }), false);
});

test('validateContacts: normalizes dates to a single YYYY-MM-DD format across mixed input formats', function () {
  var text = 'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed\n' +
    'C1,lead,free,2026-08-01,none,07/15/2026,false';
  var result = CSV.validateContacts(text);
  assert.equal(result.contacts[0].renewal_date, '2026-08-01');
  assert.equal(result.contacts[0].last_email_sent_date, '2026-07-15');
});

test('validateContacts: bundled sample_contacts.csv is clean (zero errors)', function () {
  var text = fs.readFileSync(path.join(__dirname, '..', 'data', 'sample_contacts.csv'), 'utf8');
  var result = CSV.validateContacts(text);
  assert.equal(result.fatal, false);
  assert.equal(result.errors.length, 0);
  assert.ok(result.contacts.length >= 15 && result.contacts.length <= 20);
});

// --- regression: duplicate contact_id (CRITICAL) ------------------------
// contact_id is documented (README) as the unique key; the engine keys ALL
// per-contact simulation state by it. A duplicate must never be silently
// imported — it would make two distinct CSV rows share one result object.

test('validateContacts: rejects a duplicate contact_id, keeping only the first occurrence', function () {
  var text = 'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed\n' +
    'C1,lead,free,,none,,false\n' +
    'C1,customer,pro,2026-08-01,overdue,,false\n';
  var result = CSV.validateContacts(text);
  assert.equal(result.fatal, false);
  assert.equal(result.contacts.length, 1, 'the duplicate row must be skipped, not imported');
  assert.equal(result.contacts[0].lifecycle_stage, 'lead', 'the first occurrence must be the one kept');
  assert.equal(result.skippedCount, 1);
  assert.ok(result.errors.some(function (e) { return /duplicate/i.test(e.reason) && /C1/.test(e.reason); }),
    'a clear duplicate-contact_id error naming the contact_id must be surfaced');
  assert.ok(result.errors.some(function (e) { return e.row === 3; }), 'the error must name the offending row number');
});

test('validateContacts: a third row reusing an already-duplicated contact_id is also rejected', function () {
  var text = 'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed\n' +
    'C1,lead,free,,none,,false\n' +
    'C1,customer,pro,2026-08-01,overdue,,false\n' +
    'C1,trial,enterprise,,pending,,false\n';
  var result = CSV.validateContacts(text);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.skippedCount, 2);
});

// --- regression: ambiguous unsubscribed value defaults to suppressed (LOW) ---
// Preventing inappropriate sends is this tool's purpose, so an unrecognized/
// ambiguous unsubscribed value must default to true (suppressed), not false.

test('validateContacts: an unrecognized unsubscribed value defaults to suppressed (true), not false', function () {
  var text = 'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed\n' +
    'C1,lead,free,,none,,maybe\n';
  var result = CSV.validateContacts(text);
  assert.equal(result.contacts[0].unsubscribed, true);
  assert.ok(result.errors.some(function (e) { return /unsubscribed/i.test(e.reason) && /suppressed/i.test(e.reason); }));
});
