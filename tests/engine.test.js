'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');
var Engine = require(path.join(__dirname, '..', 'src', 'engine.js'));
var SampleData = require(path.join(__dirname, '..', 'src', 'sample-data.js'));
var CSV = require(path.join(__dirname, '..', 'src', 'csv.js'));

function contact(overrides) {
  return Object.assign({
    contact_id: 'C1', lifecycle_stage: 'lead', plan: 'free', renewal_date: null,
    payment_status: 'none', last_email_sent_date: null, unsubscribed: false, custom: {}
  }, overrides);
}

function campaign(overrides) {
  return Object.assign({
    id: 'camp1', name: 'Test Campaign', type: 'invite',
    conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'lead' }],
    frequencyCapMax: 1, frequencyCapDays: 7, priority: 10
  }, overrides);
}

// --- evaluateCondition / campaignMatches -----------------------------

test('evaluateCondition: equals is case-insensitive', function () {
  var c = contact({ lifecycle_stage: 'Lead' });
  assert.equal(Engine.evaluateCondition(c, { field: 'lifecycle_stage', operator: 'equals', value: 'lead' }), true);
});

test('evaluateCondition: date operators compare normalized dates', function () {
  var c = contact({ renewal_date: '2026-08-15' });
  assert.equal(Engine.evaluateCondition(c, { field: 'renewal_date', operator: 'after', value: '2026-08-01' }), true);
  assert.equal(Engine.evaluateCondition(c, { field: 'renewal_date', operator: 'before', value: '2026-08-01' }), false);
  assert.equal(Engine.evaluateCondition(c, { field: 'renewal_date', operator: 'on_or_before', value: '2026-08-15' }), true);
});

test('evaluateCondition: missing/null field on a comparison condition is a non-match, not a crash', function () {
  var c = contact({ renewal_date: null });
  assert.doesNotThrow(function () {
    var result = Engine.evaluateCondition(c, { field: 'renewal_date', operator: 'after', value: '2026-08-01' });
    assert.equal(result, false);
  });
});

test('evaluateCondition: is_empty / is_not_empty detect missing custom fields', function () {
  var c = contact({ custom: { region: null } });
  assert.equal(Engine.evaluateCondition(c, { field: 'region', operator: 'is_empty' }), true);
  assert.equal(Engine.evaluateCondition(c, { field: 'region', operator: 'is_not_empty' }), false);
});

test('campaignMatches: AND-only — all conditions must pass', function () {
  var c = contact({ lifecycle_stage: 'customer', plan: 'pro' });
  var camp = campaign({
    conditions: [
      { field: 'lifecycle_stage', operator: 'equals', value: 'customer' },
      { field: 'plan', operator: 'equals', value: 'enterprise' }
    ]
  });
  assert.equal(Engine.campaignMatches(c, camp), false); // second condition fails
});

test('campaignMatches: a campaign with zero conditions never matches anyone', function () {
  var c = contact({});
  var camp = campaign({ conditions: [] });
  assert.equal(Engine.campaignMatches(c, camp), false);
});

// --- findDeadCampaigns -------------------------------------------------

test('findDeadCampaigns: flags a campaign whose conditions match no imported contact', function () {
  var contacts = [contact({ lifecycle_stage: 'lead' }), contact({ contact_id: 'C2', lifecycle_stage: 'trial' })];
  var campaigns = [
    campaign({ id: 'alive', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'lead' }] }),
    campaign({ id: 'dead', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'evangelist' }] })
  ];
  var dead = Engine.findDeadCampaigns(contacts, campaigns);
  assert.deepEqual(dead, ['dead']);
});

// --- validateCampaign ---------------------------------------------------

test('validateCampaign: requires name, type, at least one condition, positive integer caps, integer priority', function () {
  var errs = Engine.validateCampaign({
    name: '', type: 'bogus', conditions: [],
    frequencyCapMax: 0, frequencyCapDays: -1, priority: 1.5
  });
  assert.ok(errs.some(function (e) { return /name/i.test(e); }));
  assert.ok(errs.some(function (e) { return /type/i.test(e); }));
  assert.ok(errs.some(function (e) { return /zero conditions/i.test(e); }));
  assert.ok(errs.some(function (e) { return /Frequency cap max/i.test(e); }));
  assert.ok(errs.some(function (e) { return /window/i.test(e); }));
  assert.ok(errs.some(function (e) { return /Priority/i.test(e); }));
});

test('validateCampaign: a well-formed campaign passes with no errors', function () {
  var errs = Engine.validateCampaign(campaign({}));
  assert.deepEqual(errs, []);
});

test('validateCampaign: priority ties are explicitly allowed (not an error)', function () {
  var errs = Engine.validateCampaign(campaign({ priority: 10 }));
  assert.deepEqual(errs, []);
});

// --- simulate: suppression precedence -----------------------------------

test('simulate: unsubscribed suppresses every campaign, including payment_reminder', function () {
  var c = contact({ contact_id: 'U1', lifecycle_stage: 'customer', unsubscribed: true, payment_status: 'overdue' });
  var camp = campaign({ type: 'payment_reminder', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  var row = result.results[0];
  assert.equal(row.sent.length, 0);
  assert.equal(row.blocked.length, 1);
  assert.equal(row.blocked[0].rule, 'unsubscribed');
});

test('simulate: payment_reminder is blocked when payment_status is paid', function () {
  var c = contact({ contact_id: 'P1', lifecycle_stage: 'customer', payment_status: 'paid' });
  var camp = campaign({ type: 'payment_reminder', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  var row = result.results[0];
  assert.equal(row.sent.length, 0);
  assert.equal(row.blocked[0].rule, 'already_paid');
});

test('simulate: payment_reminder still sends when payment_status is not paid', function () {
  var c = contact({ contact_id: 'P2', lifecycle_stage: 'customer', payment_status: 'overdue' });
  var camp = campaign({ type: 'payment_reminder', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  assert.equal(result.results[0].sent.length, 1);
});

test('simulate: frequency cap blocks once the rolling-window max is reached', function () {
  var c = contact({ contact_id: 'F1', last_email_sent_date: '2026-07-28' });
  var camp = campaign({ frequencyCapMax: 1, frequencyCapDays: 7 }); // window 07-26..08-01
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  var row = result.results[0];
  assert.equal(row.sent.length, 0);
  assert.equal(row.blocked[0].rule, 'frequency_cap');
});

test('simulate: frequency cap allows a send when last email falls outside the rolling window', function () {
  var c = contact({ contact_id: 'F2', last_email_sent_date: '2026-06-01' });
  var camp = campaign({ frequencyCapMax: 1, frequencyCapDays: 7 });
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  assert.equal(result.results[0].sent.length, 1);
});

test('simulate: global daily cap blocks additional campaigns beyond the configured max', function () {
  var c = contact({ contact_id: 'G1', lifecycle_stage: 'customer', plan: 'pro' });
  var campA = campaign({ id: 'a', name: 'A Campaign', priority: 1, conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var campB = campaign({ id: 'b', name: 'B Campaign', priority: 2, conditions: [{ field: 'plan', operator: 'equals', value: 'pro' }] });
  var result = Engine.simulate([c], [campA, campB], { startDate: '2026-08-01', globalDailyCapEnabled: true, globalDailyCapMax: 1 });
  var row = result.results[0];
  assert.equal(row.sent.length, 1);
  assert.equal(row.sent[0].campaign_id, 'a'); // lower priority number wins the slot
  assert.equal(row.blocked.length, 1);
  assert.equal(row.blocked[0].rule, 'global_daily_cap');
});

// --- simulate: conflicts and tie-break ----------------------------------

test('simulate: two campaigns firing the same day are flagged as a conflict, ordered by priority', function () {
  var c = contact({ contact_id: 'X1', lifecycle_stage: 'customer', plan: 'pro' });
  var campLow = campaign({ id: 'low', name: 'Low Priority', priority: 5, conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var campHigh = campaign({ id: 'high', name: 'High Priority', priority: 1, conditions: [{ field: 'plan', operator: 'equals', value: 'pro' }] });
  var result = Engine.simulate([c], [campLow, campHigh], { startDate: '2026-08-01' });
  var row = result.results[0];
  assert.equal(row.sent.length, 2);
  assert.equal(row.sent[0].campaign_id, 'high'); // priority 1 sends first
  assert.equal(row.sent[1].campaign_id, 'low');
  assert.equal(row.conflicts.length, 1);
  assert.match(row.conflicts[0].tie_break_reason, /priority/i);
});

test('simulate: equal-priority conflicts break the tie alphabetically by campaign name', function () {
  var c = contact({ contact_id: 'X2', lifecycle_stage: 'customer', plan: 'pro' });
  var campZ = campaign({ id: 'z', name: 'Zeta Campaign', priority: 5, conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var campA = campaign({ id: 'a', name: 'Alpha Campaign', priority: 5, conditions: [{ field: 'plan', operator: 'equals', value: 'pro' }] });
  var result = Engine.simulate([c], [campZ, campA], { startDate: '2026-08-01' });
  var row = result.results[0];
  assert.equal(row.sent[0].campaign_id, 'a'); // alphabetical tie-break
  assert.equal(row.sent[1].campaign_id, 'z');
});

// --- simulate: edge cases -------------------------------------------

test('simulate: a contact matching zero campaigns is listed explicitly as no-activity', function () {
  var c = contact({ contact_id: 'N1', lifecycle_stage: 'evangelist' });
  var camp = campaign({ conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'lead' }] });
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  assert.deepEqual(result.noActivityContactIds, ['N1']);
  assert.equal(result.results[0].sent.length, 0);
  assert.equal(result.results[0].blocked.length, 0);
});

test('simulate: a dead campaign is reported in the summary', function () {
  var c = contact({ contact_id: 'D1', lifecycle_stage: 'lead' });
  var deadCamp = campaign({ id: 'dead1', conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'nonexistent' }] });
  var result = Engine.simulate([c], [deadCamp], { startDate: '2026-08-01' });
  assert.deepEqual(result.deadCampaignIds, ['dead1']);
});

test('simulate: deterministic across repeated runs on the same inputs', function () {
  var c = contact({ contact_id: 'R1', lifecycle_stage: 'customer', plan: 'pro' });
  var campA = campaign({ id: 'a', name: 'A', priority: 5, conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'customer' }] });
  var campB = campaign({ id: 'b', name: 'B', priority: 5, conditions: [{ field: 'plan', operator: 'equals', value: 'pro' }] });
  var r1 = Engine.simulate([c], [campA, campB], { startDate: '2026-08-01' });
  var r2 = Engine.simulate([c], [campA, campB], { startDate: '2026-08-01' });
  assert.deepEqual(r1.results[0].sent.map(function (s) { return s.campaign_id; }), r2.results[0].sent.map(function (s) { return s.campaign_id; }));
});

test('simulate: each campaign\'s frequency cap is enforced against its own send history only, never a shared one', function () {
  // Campaign A (cap 1/30 days) and Campaign B (cap 5/30 days) both match the same
  // contact every day. Under the bug, all sends (from either campaign) were appended to
  // one shared per-contact history array, so B's sends counted against A's cap and vice
  // versa. Here that would make A's blocked-reason count balloon past 1, and would
  // eventually block B on day 5 even though B never sent more than 4 times before then.
  var c = contact({ contact_id: 'X1', lifecycle_stage: 'lead', plan: 'pro', last_email_sent_date: null });
  var campA = campaign({ id: 'A', name: 'CampA', priority: 1, frequencyCapMax: 1, frequencyCapDays: 30,
    conditions: [{ field: 'lifecycle_stage', operator: 'equals', value: 'lead' }] });
  var campB = campaign({ id: 'B', name: 'CampB', priority: 2, frequencyCapMax: 5, frequencyCapDays: 30,
    conditions: [{ field: 'plan', operator: 'equals', value: 'pro' }] });
  var result = Engine.simulate([c], [campA, campB], { startDate: '2026-07-01', endDate: '2026-07-05' });
  var row = result.results[0];

  var bSent = row.sent.filter(function (s) { return s.campaign_id === 'B'; });
  assert.equal(bSent.length, 5, 'CampB (cap 5/30d) must send all 5 days — CampA\'s sends must never consume its budget');

  var aBlocked = row.blocked.filter(function (b) { return b.campaign_id === 'A'; });
  assert.equal(aBlocked.length, 4); // days 2-5, capped by its own single send on day 1
  aBlocked.forEach(function (b) {
    assert.match(b.reason, /\(1 already counted/, 'CampA\'s own count must reflect only its own sends, not CampB\'s');
  });

  var bBlocked = row.blocked.filter(function (b) { return b.campaign_id === 'B'; });
  assert.equal(bBlocked.length, 0, 'CampB must never be blocked by CampA\'s sends polluting a shared history');
});

test('simulate: a multi-day range accumulates frequency-cap history across days', function () {
  var c = contact({ contact_id: 'M1' });
  var camp = campaign({ frequencyCapMax: 1, frequencyCapDays: 3 });
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01', endDate: '2026-08-03' });
  var row = result.results[0];
  assert.equal(row.sent.length, 1); // sends once on day 1
  assert.equal(row.blocked.length, 2); // capped on day 2 and day 3 (window includes day 1's send)
});

// --- resultsToCSV --------------------------------------------------

test('resultsToCSV: produces a CSV with a header and one line per event', function () {
  var c = contact({ contact_id: 'CSV1', lifecycle_stage: 'lead' });
  var camp = campaign({});
  var result = Engine.simulate([c], [camp], { startDate: '2026-08-01' });
  var csv = Engine.resultsToCSV(result);
  var lines = csv.split('\n');
  assert.match(lines[0], /^contact_id,date,status/);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^CSV1,2026-08-01,SENT/);
});

// --- integration: the bundled sample dataset demonstrates the core value ---

test('sample dataset: loading sample data produces at least one of each showcase behavior', function () {
  var parsed = CSV.validateContacts(SampleData.SAMPLE_CONTACTS_CSV);
  assert.equal(parsed.errors.length, 0);
  var contacts = parsed.contacts;
  var campaigns = SampleData.SAMPLE_CAMPAIGNS;

  var result = Engine.simulate(contacts, campaigns, { startDate: SampleData.SAMPLE_SIMULATE_DATE });

  var allBlocked = [];
  var conflictCount = 0;
  result.results.forEach(function (row) {
    allBlocked = allBlocked.concat(row.blocked);
    if (row.conflicts.length) conflictCount++;
  });

  assert.ok(allBlocked.some(function (b) { return b.rule === 'unsubscribed'; }), 'expected at least one unsubscribed block');
  assert.ok(allBlocked.some(function (b) { return b.rule === 'frequency_cap'; }), 'expected at least one frequency-cap block');
  assert.ok(allBlocked.some(function (b) { return b.rule === 'already_paid'; }), 'expected at least one already-paid block');
  assert.ok(conflictCount >= 1, 'expected at least one same-day conflict');
});
