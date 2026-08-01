/**
 * csv.js - dependency-free CSV parsing, validation, and date normalization
 * for lifecycle-mail-sim. Works in Node (via module.exports) and in the
 * browser (via window.LifecycleCSV) when loaded with a plain <script> tag.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LifecycleCSV = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REQUIRED_COLUMNS = [
    'contact_id',
    'lifecycle_stage',
    'plan',
    'renewal_date',
    'payment_status',
    'last_email_sent_date',
    'unsubscribed'
  ];

  var DATE_FIELDS = ['renewal_date', 'last_email_sent_date'];

  // Parses raw CSV text into an array of row objects (string values) plus
  // the header list. Handles quoted fields and commas inside quotes.
  function parseCSVText(text) {
    var rows = [];
    var i = 0;
    var field = '';
    var row = [];
    var inQuotes = false;
    var len = text.length;

    function pushField() {
      row.push(field);
      field = '';
    }
    function pushRow() {
      pushField();
      rows.push(row);
      row = [];
    }

    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === ',') {
        pushField();
        i++;
        continue;
      }
      if (c === '\r') {
        i++;
        continue;
      }
      if (c === '\n') {
        pushRow();
        i++;
        continue;
      }
      field += c;
      i++;
    }
    // last field/row (if the file doesn't end with a newline)
    if (field.length > 0 || row.length > 0) {
      pushRow();
    }
    // drop fully-empty trailing rows
    rows = rows.filter(function (r) {
      return !(r.length === 1 && r[0] === '');
    });
    return rows;
  }

  // Normalizes a date-ish string to 'YYYY-MM-DD'. Accepts YYYY-MM-DD,
  // MM/DD/YYYY, M/D/YYYY. Returns null if unparseable or empty.
  function normalizeDate(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (s === '') return null;

    var isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (isoMatch) {
      var y = Number(isoMatch[1]), m = Number(isoMatch[2]), d = Number(isoMatch[3]);
      if (isValidDate(y, m, d)) return isoMatch[1] + '-' + isoMatch[2] + '-' + isoMatch[3];
      return null;
    }

    var usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (usMatch) {
      var mm = Number(usMatch[1]), dd = Number(usMatch[2]), yy = Number(usMatch[3]);
      if (isValidDate(yy, mm, dd)) {
        return yy + '-' + pad2(mm) + '-' + pad2(dd);
      }
      return null;
    }

    return null;
  }

  function isValidDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function normalizeBoolean(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim().toLowerCase();
    if (s === '') return null;
    if (['true', 'yes', 'y', '1'].indexOf(s) !== -1) return true;
    if (['false', 'no', 'n', '0'].indexOf(s) !== -1) return false;
    return null;
  }

  // Validates parsed CSV rows against the fixed required-column schema.
  // Returns { contacts, errors, skippedCount, columns }.
  // - contacts: array of clean contact objects (invalid rows excluded)
  // - errors: array of { row, reason } describing skipped/flagged rows
  // - skippedCount: number of rows skipped entirely
  function validateContacts(text) {
    var errors = [];
    if (!text || String(text).trim() === '') {
      return {
        contacts: [],
        errors: [{ row: 0, reason: 'File is empty.' }],
        skippedCount: 0,
        columns: [],
        fatal: true
      };
    }

    var rows = parseCSVText(text);
    if (rows.length === 0) {
      return {
        contacts: [],
        errors: [{ row: 0, reason: 'File is empty.' }],
        skippedCount: 0,
        columns: [],
        fatal: true
      };
    }

    var header = rows[0].map(function (h) { return h.trim(); });
    var missing = REQUIRED_COLUMNS.filter(function (col) { return header.indexOf(col) === -1; });
    if (missing.length > 0) {
      return {
        contacts: [],
        errors: [{ row: 0, reason: 'Missing required column(s): ' + missing.join(', ') }],
        skippedCount: 0,
        columns: header,
        fatal: true
      };
    }

    var customFields = header.filter(function (h) { return REQUIRED_COLUMNS.indexOf(h) === -1 && h !== ''; });
    var contacts = [];
    var skippedCount = 0;
    // Tracks the first row number each contact_id was successfully imported at, so a
    // later row reusing the same contact_id can be detected and rejected instead of
    // silently overwriting/comingling state with the first contact (see engine.js,
    // which keys all per-contact simulation state by contact_id).
    var seenContactIds = {};

    for (var r = 1; r < rows.length; r++) {
      var raw = rows[r];
      if (raw.length === 1 && raw[0].trim() === '') continue; // blank line
      var rowNum = r + 1; // 1-indexed with header as row 1

      if (raw.length !== header.length) {
        errors.push({ row: rowNum, reason: 'Expected ' + header.length + ' columns, found ' + raw.length + '.' });
        skippedCount++;
        continue;
      }

      var obj = {};
      for (var c = 0; c < header.length; c++) {
        obj[header[c]] = raw[c] !== undefined ? raw[c].trim() : '';
      }

      if (!obj.contact_id) {
        errors.push({ row: rowNum, reason: 'Missing contact_id.' });
        skippedCount++;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(seenContactIds, obj.contact_id)) {
        errors.push({
          row: rowNum,
          reason: 'Duplicate contact_id "' + obj.contact_id + '" (first seen at row ' + seenContactIds[obj.contact_id] +
            '); contact_id must be unique. This row was skipped so it cannot silently share simulation state with the earlier row.'
        });
        skippedCount++;
        continue;
      }
      seenContactIds[obj.contact_id] = rowNum;

      var renewalNorm = normalizeDate(obj.renewal_date);
      var renewalFlagged = obj.renewal_date && !renewalNorm;
      var lastEmailNorm = normalizeDate(obj.last_email_sent_date);
      var lastEmailFlagged = obj.last_email_sent_date && !lastEmailNorm;

      if (renewalFlagged) {
        errors.push({ row: rowNum, reason: 'Unparseable renewal_date "' + obj.renewal_date + '" (contact ' + obj.contact_id + ') - field treated as missing.' });
      }
      if (lastEmailFlagged) {
        errors.push({ row: rowNum, reason: 'Unparseable last_email_sent_date "' + obj.last_email_sent_date + '" (contact ' + obj.contact_id + ') - field treated as missing.' });
      }

      var unsubBool = normalizeBoolean(obj.unsubscribed);
      // An unrecognized value is ambiguous, not "no signal" — for a tool whose purpose is
      // preventing inappropriate sends, an ambiguous suppression signal must default to
      // suppressed (true), never to "eligible to receive mail" (false).
      var unsubAmbiguous = !!obj.unsubscribed && unsubBool === null;
      if (unsubAmbiguous) {
        errors.push({ row: rowNum, reason: 'Unrecognized unsubscribed value "' + obj.unsubscribed + '" (contact ' + obj.contact_id + ') - treated as true (suppressed) for safety.' });
      }

      var contact = {
        contact_id: obj.contact_id,
        lifecycle_stage: obj.lifecycle_stage || null,
        plan: obj.plan || null,
        renewal_date: renewalNorm,
        payment_status: obj.payment_status || null,
        last_email_sent_date: lastEmailNorm,
        unsubscribed: unsubAmbiguous ? true : unsubBool === true,
        custom: {}
      };
      customFields.forEach(function (f) {
        contact.custom[f] = obj[f] !== '' ? obj[f] : null;
      });

      contacts.push(contact);
    }

    return {
      contacts: contacts,
      errors: errors,
      skippedCount: skippedCount,
      columns: header,
      customFields: customFields,
      fatal: false
    };
  }

  return {
    REQUIRED_COLUMNS: REQUIRED_COLUMNS,
    DATE_FIELDS: DATE_FIELDS,
    parseCSVText: parseCSVText,
    normalizeDate: normalizeDate,
    normalizeBoolean: normalizeBoolean,
    validateContacts: validateContacts
  };
}));
