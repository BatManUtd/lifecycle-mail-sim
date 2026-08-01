/**
 * engine.js - dependency-free simulation engine for lifecycle-mail-sim.
 * Works in Node (via module.exports) and in the browser (via
 * window.LifecycleEngine) when loaded with a plain <script> tag after
 * csv.js.
 *
 * This module implements a RULES MODEL that the user configures. It is
 * not a live read of any real ESP (HubSpot/Marketo/Customer.io/Braze)
 * campaign configuration. See README.md "Methodology & limitations".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'));
  } else {
    root.LifecycleEngine = factory(root.LifecycleCSV);
  }
}(typeof self !== 'undefined' ? self : this, function (CSV) {
  'use strict';

  var CAMPAIGN_TYPES = ['promo', 'invite', 'nurture', 'newsletter', 'payment_reminder', 'renewal'];

  var OPERATORS = ['equals', 'not_equals', 'contains', 'before', 'after', 'on_or_before', 'on_or_after', 'is_empty', 'is_not_empty'];

  var CONTACT_FIELDS = ['contact_id', 'lifecycle_stage', 'plan', 'renewal_date', 'payment_status', 'last_email_sent_date', 'unsubscribed'];

  // ---------------------------------------------------------------------
  // Date helpers (all dates are 'YYYY-MM-DD' strings, compared as UTC days)
  // ---------------------------------------------------------------------
  function dateToDays(iso) {
    if (!iso) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  }

  function daysToDate(days) {
    var d = new Date(days * 86400000);
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }

  function p2(n) { return n < 10 ? '0' + n : String(n); }

  function addDays(iso, n) {
    return daysToDate(dateToDays(iso) + n);
  }

  function enumerateDates(startIso, endIso) {
    var out = [];
    var s = dateToDays(startIso);
    var e = dateToDays(endIso || startIso);
    for (var d = s; d <= e; d++) out.push(daysToDate(d));
    return out;
  }

  // ---------------------------------------------------------------------
  // Field resolution: contact fixed fields + custom fields.
  // Missing/null value => resolves to null (never throws).
  // ---------------------------------------------------------------------
  function getFieldValue(contact, field) {
    if (CONTACT_FIELDS.indexOf(field) !== -1) {
      var v = contact[field];
      return v === undefined ? null : v;
    }
    if (contact.custom && Object.prototype.hasOwnProperty.call(contact.custom, field)) {
      var cv = contact.custom[field];
      return cv === undefined ? null : cv;
    }
    return null;
  }

  // Evaluates a single {field, operator, value} condition against a contact.
  // A missing/null field value on the contact always evaluates to
  // non-match (false) rather than throwing, EXCEPT for is_empty which is
  // designed to detect exactly that case.
  function evaluateCondition(contact, condition) {
    var actual = getFieldValue(contact, condition.field);

    if (condition.operator === 'is_empty') {
      return actual === null || actual === '' || actual === undefined;
    }
    if (condition.operator === 'is_not_empty') {
      return actual !== null && actual !== '' && actual !== undefined;
    }

    if (actual === null || actual === undefined || actual === '') {
      return false; // missing field on a comparison condition => non-match, not a crash
    }

    switch (condition.operator) {
      case 'equals':
        return String(actual).toLowerCase() === String(condition.value).toLowerCase();
      case 'not_equals':
        return String(actual).toLowerCase() !== String(condition.value).toLowerCase();
      case 'contains':
        return String(actual).toLowerCase().indexOf(String(condition.value).toLowerCase()) !== -1;
      case 'before':
      case 'after':
      case 'on_or_before':
      case 'on_or_after': {
        var actualDays = dateToDays(actual);
        var targetDays = dateToDays(condition.value);
        if (actualDays === null || targetDays === null) return false;
        if (condition.operator === 'before') return actualDays < targetDays;
        if (condition.operator === 'after') return actualDays > targetDays;
        if (condition.operator === 'on_or_before') return actualDays <= targetDays;
        if (condition.operator === 'on_or_after') return actualDays >= targetDays;
        return false;
      }
      default:
        return false;
    }
  }

  // A campaign matches a contact when ALL of its conditions are true (AND-only).
  // A campaign with zero conditions never matches (guarded at save-time too).
  function campaignMatches(contact, campaign) {
    if (!campaign.conditions || campaign.conditions.length === 0) return false;
    return campaign.conditions.every(function (cond) { return evaluateCondition(contact, cond); });
  }

  // relative-to-simulated-day conditions: 'renewal_date' etc. may reference
  // {{today}} as a value placeholder, resolved per simulated date.
  function resolveConditionValue(condition, todayIso) {
    if (condition.value === '{{today}}') {
      return Object.assign({}, condition, { value: todayIso });
    }
    return condition;
  }

  function campaignMatchesOnDate(contact, campaign, todayIso) {
    if (!campaign.conditions || campaign.conditions.length === 0) return false;
    return campaign.conditions.every(function (cond) {
      return evaluateCondition(contact, resolveConditionValue(cond, todayIso));
    });
  }

  // ---------------------------------------------------------------------
  // Dead campaign detection: a campaign whose conditions can never match
  // ANY imported contact (checked independent of suppression/date).
  // ---------------------------------------------------------------------
  function findDeadCampaigns(contacts, campaigns) {
    return campaigns.filter(function (c) {
      if (!c.conditions || c.conditions.length === 0) return true;
      return !contacts.some(function (contact) {
        return campaignMatches(contact, c);
      });
    }).map(function (c) { return c.id; });
  }

  // ---------------------------------------------------------------------
  // Simulation
  //
  // Suppression precedence (fixed, non-editable), evaluated in order per
  // campaign x contact x day:
  //   1. unsubscribed
  //   2. payment_status = paid (payment_reminder campaigns only)
  //   3. frequency cap exceeded (campaign's own max-per-rolling-N-days)
  //   4. global daily send cap (if enabled)
  //
  // Tie-break rule for same-day multi-campaign sends (shown in UI):
  //   Sort by ascending campaign.priority (lower number sends first).
  //   Equal priority is broken by campaign name (A-Z), deterministically.
  //   Any contact with 2+ sends on the same day is flagged as a conflict.
  // ---------------------------------------------------------------------
  function simulate(contacts, campaigns, options) {
    options = options || {};
    var startDate = options.startDate;
    var endDate = options.endDate || options.startDate;
    var globalCapEnabled = !!options.globalDailyCapEnabled;
    var globalCapMax = options.globalDailyCapMax || 1;

    var dates = enumerateDates(startDate, endDate);
    var deadCampaignIds = findDeadCampaigns(contacts, campaigns);

    // Per-contact, PER-CAMPAIGN rolling send history: history[contact_id][campaign_id] is
    // an array of ISO date strings. Each campaign's frequency cap is enforced only against
    // its own history for that contact — never shared with other campaigns, so one
    // campaign's sends can never consume another campaign's cap budget. The CSV only
    // carries one last_email_sent_date per contact (not a per-campaign log), so that single
    // date is used to seed every campaign's history independently as the historical
    // baseline (see README "Methodology notes").
    var history = {};
    contacts.forEach(function (c) {
      var perCampaign = {};
      campaigns.forEach(function (camp) {
        perCampaign[camp.id] = c.last_email_sent_date ? [c.last_email_sent_date] : [];
      });
      history[c.contact_id] = perCampaign;
    });

    var perContactResults = {};
    contacts.forEach(function (c) {
      perContactResults[c.contact_id] = { contact: c, sent: [], blocked: [], conflicts: [] };
    });

    var sortedCampaigns = campaigns.slice().sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return String(a.name).localeCompare(String(b.name));
    });

    dates.forEach(function (today) {
      contacts.forEach(function (contact) {
        var res = perContactResults[contact.contact_id];
        var candidates = [];

        sortedCampaigns.forEach(function (campaign) {
          if (!campaignMatchesOnDate(contact, campaign, today)) return;

          var matchedConditions = campaign.conditions.map(function (cond) {
            return describeCondition(cond, today);
          });

          // 1. unsubscribed
          if (contact.unsubscribed) {
            res.blocked.push({
              date: today,
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              campaign_type: campaign.type,
              rule: 'unsubscribed',
              reason: 'Contact has unsubscribed; all campaigns are suppressed.',
              matched_conditions: matchedConditions
            });
            return;
          }

          // 2. payment reminder blocked if already paid
          if (campaign.type === 'payment_reminder' && String(contact.payment_status).toLowerCase() === 'paid') {
            res.blocked.push({
              date: today,
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              campaign_type: campaign.type,
              rule: 'already_paid',
              reason: 'payment_status is "paid"; payment reminders are suppressed.',
              matched_conditions: matchedConditions
            });
            return;
          }

          // 3. frequency cap (this campaign's own cap, rolling N days ending today,
          // checked against this campaign's own history only)
          var campaignHistory = history[contact.contact_id][campaign.id];
          var windowStart = addDays(today, -(campaign.frequencyCapDays - 1));
          var countInWindow = campaignHistory.filter(function (d) {
            return d >= windowStart && d <= today;
          }).length;
          if (countInWindow >= campaign.frequencyCapMax) {
            res.blocked.push({
              date: today,
              campaign_id: campaign.id,
              campaign_name: campaign.name,
              campaign_type: campaign.type,
              rule: 'frequency_cap',
              reason: 'Frequency cap of ' + campaign.frequencyCapMax + ' per ' + campaign.frequencyCapDays +
                ' day(s) reached (' + countInWindow + ' already counted in window ' + windowStart + '..' + today + ').',
              matched_conditions: matchedConditions
            });
            return;
          }

          candidates.push({ campaign: campaign, matched_conditions: matchedConditions });
        });

        // 4. global daily cap, applied after per-campaign candidates are known,
        // in priority order (already sorted).
        var allowed = [];
        candidates.forEach(function (cand) {
          if (globalCapEnabled && allowed.length >= globalCapMax) {
            res.blocked.push({
              date: today,
              campaign_id: cand.campaign.id,
              campaign_name: cand.campaign.name,
              campaign_type: cand.campaign.type,
              rule: 'global_daily_cap',
              reason: 'Global daily send cap of ' + globalCapMax + ' reached for this contact on ' + today + '.',
              matched_conditions: cand.matched_conditions
            });
            return;
          }
          allowed.push(cand);
        });

        allowed.forEach(function (cand, idx) {
          res.sent.push({
            date: today,
            campaign_id: cand.campaign.id,
            campaign_name: cand.campaign.name,
            campaign_type: cand.campaign.type,
            priority: cand.campaign.priority,
            order: idx + 1,
            matched_conditions: cand.matched_conditions
          });
          history[contact.contact_id][cand.campaign.id].push(today);
        });

        if (allowed.length > 1) {
          var tieBreakReason = 'Ordered by ascending campaign priority (lower number sends first); ' +
            'campaigns with equal priority are broken alphabetically by campaign name.';
          res.conflicts.push({
            date: today,
            campaigns: allowed.map(function (a) { return { id: a.campaign.id, name: a.campaign.name, priority: a.campaign.priority }; }),
            tie_break_reason: tieBreakReason
          });
        }
      });
    });

    var noActivity = contacts
      .filter(function (c) {
        var r = perContactResults[c.contact_id];
        return r.sent.length === 0 && r.blocked.length === 0;
      })
      .map(function (c) { return c.contact_id; });

    return {
      dates: dates,
      results: contacts.map(function (c) { return perContactResults[c.contact_id]; }),
      deadCampaignIds: deadCampaignIds,
      noActivityContactIds: noActivity
    };
  }

  function describeCondition(cond, today) {
    var resolved = resolveConditionValue(cond, today);
    return resolved.field + ' ' + resolved.operator + (resolved.operator === 'is_empty' || resolved.operator === 'is_not_empty' ? '' : ' "' + resolved.value + '"');
  }

  // ---------------------------------------------------------------------
  // Campaign validation (used by the UI form before save)
  // ---------------------------------------------------------------------
  function validateCampaign(campaign, existingCampaigns) {
    var errs = [];
    if (!campaign.name || !campaign.name.trim()) errs.push('Campaign name is required.');
    if (CAMPAIGN_TYPES.indexOf(campaign.type) === -1) errs.push('Campaign type must be one of: ' + CAMPAIGN_TYPES.join(', ') + '.');
    if (!campaign.conditions || campaign.conditions.length === 0) errs.push('At least one condition is required (a campaign with zero conditions would silently match everyone).');
    (campaign.conditions || []).forEach(function (cond, i) {
      if (!cond.field) errs.push('Condition ' + (i + 1) + ': field is required.');
      if (OPERATORS.indexOf(cond.operator) === -1) errs.push('Condition ' + (i + 1) + ': invalid operator.');
      if (['is_empty', 'is_not_empty'].indexOf(cond.operator) === -1 && (cond.value === undefined || cond.value === '')) {
        errs.push('Condition ' + (i + 1) + ': value is required.');
      }
    });
    if (!Number.isInteger(campaign.frequencyCapMax) || campaign.frequencyCapMax <= 0) errs.push('Frequency cap max must be a positive integer.');
    if (!Number.isInteger(campaign.frequencyCapDays) || campaign.frequencyCapDays <= 0) errs.push('Frequency cap window (days) must be a positive integer.');
    if (!Number.isInteger(campaign.priority)) errs.push('Priority must be an integer.');
    return errs;
  }

  // ---------------------------------------------------------------------
  // Export helpers
  // ---------------------------------------------------------------------
  function resultsToCSV(simResult) {
    var lines = ['contact_id,date,status,campaign_id,campaign_name,campaign_type,rule_or_priority,detail'];
    simResult.results.forEach(function (r) {
      r.sent.forEach(function (s) {
        lines.push([r.contact.contact_id, s.date, 'SENT', s.campaign_id, csvEsc(s.campaign_name), s.campaign_type, 'priority ' + s.priority, csvEsc(s.matched_conditions.join(' AND '))].join(','));
      });
      r.blocked.forEach(function (b) {
        lines.push([r.contact.contact_id, b.date, 'BLOCKED', b.campaign_id, csvEsc(b.campaign_name), b.campaign_type, b.rule, csvEsc(b.reason)].join(','));
      });
      if (r.sent.length === 0 && r.blocked.length === 0) {
        lines.push([r.contact.contact_id, '', 'NO_ACTIVITY', '', '', '', '', 'Matched zero campaigns'].join(','));
      }
    });
    return lines.join('\n');
  }

  function csvEsc(s) {
    s = String(s === undefined || s === null ? '' : s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  return {
    CAMPAIGN_TYPES: CAMPAIGN_TYPES,
    OPERATORS: OPERATORS,
    CONTACT_FIELDS: CONTACT_FIELDS,
    dateToDays: dateToDays,
    daysToDate: daysToDate,
    addDays: addDays,
    enumerateDates: enumerateDates,
    getFieldValue: getFieldValue,
    evaluateCondition: evaluateCondition,
    campaignMatches: campaignMatches,
    campaignMatchesOnDate: campaignMatchesOnDate,
    findDeadCampaigns: findDeadCampaigns,
    simulate: simulate,
    validateCampaign: validateCampaign,
    resultsToCSV: resultsToCSV
  };
}));
