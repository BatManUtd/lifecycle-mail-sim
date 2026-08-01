'use strict';
/**
 * app.test.js - regression coverage for the "fatal import errors are silently
 * hidden" bug (ISSUE 2). app.js is a browser-only DOM-wiring module with no
 * existing test harness, so this file provides a minimal, purpose-built DOM
 * stub (just enough surface for app.js's init()/render path to run) rather
 * than pulling in a new dependency like jsdom.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');

var APP_PATH = path.join(__dirname, '..', 'src', 'app.js');
var CSV_PATH = path.join(__dirname, '..', 'src', 'csv.js');
var ENGINE_PATH = path.join(__dirname, '..', 'src', 'engine.js');
var SAMPLE_DATA_PATH = path.join(__dirname, '..', 'src', 'sample-data.js');

function makeElement(id) {
  var listeners = {};
  var el = {
    id: id,
    hidden: false,
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    children: [],
    appendChild: function (child) { this.children.push(child); return child; },
    addEventListener: function (type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
    removeEventListener: function () {},
    dispatchEvent: function (type, evt) { (listeners[type] || []).slice().forEach(function (cb) { cb(evt || {}); }); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    setAttribute: function () {},
    getAttribute: function () { return null; },
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    remove: function () {}
  };
  return el;
}

// Builds a fresh, isolated document/window stub plus a fresh require of
// app.js (bypassing the module cache so each test gets its own STATE
// closure), and fires DOMContentLoaded so init() wires everything up.
function bootApp() {
  var elementsById = {};
  var domListeners = {};

  var document = {
    getElementById: function (id) { return elementsById[id] || (elementsById[id] = makeElement(id)); },
    createElement: function () { return makeElement(null); },
    addEventListener: function (type, cb) { (domListeners[type] = domListeners[type] || []).push(cb); },
    body: makeElement('body')
  };

  global.document = document;
  global.window = {
    LifecycleCSV: require(CSV_PATH),
    LifecycleEngine: require(ENGINE_PATH),
    LifecycleSampleData: require(SAMPLE_DATA_PATH)
  };
  global.FileReader = function () {
    var self = this;
    this.onload = null;
    this.onerror = null;
    this.readAsText = function (file) {
      if (file && typeof file.__text === 'string') {
        self.onload({ target: { result: file.__text } });
      } else if (self.onerror) {
        self.onerror();
      }
    };
  };

  delete require.cache[require.resolve(APP_PATH)];
  require(APP_PATH);
  (domListeners.DOMContentLoaded || []).forEach(function (cb) { cb(); });

  return elementsById;
}

function fireFileChange(el, csvText) {
  el['csv-file-input'].dispatchEvent('change', { target: { files: [{ __text: csvText }], value: '' } });
}

var VALID_CSV = 'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed\n' +
  'C1,lead,free,,none,,false\n';

test('app: a fatal import error is shown even with zero contacts loaded (not hidden behind the empty state)', function () {
  var el = bootApp();

  fireFileChange(el, ''); // empty file -> fatal

  assert.equal(el['app-body'].hidden, true, 'no contacts, so app-body correctly stays hidden');
  assert.equal(el['import-summary'].hidden, false, 'the fatal-error panel must be visible regardless of app-body being hidden');
  assert.match(el['import-summary'].innerHTML, /empty/i);
});

test('app: a fatal re-import does not silently wipe previously loaded contacts, and shows the new error', function () {
  var el = bootApp();

  fireFileChange(el, VALID_CSV);
  assert.equal(el['app-body'].hidden, false);
  assert.equal(el['contacts-count'].textContent, '1');
  assert.equal(el['import-summary'].hidden, true, 'no errors after a clean import');

  fireFileChange(el, ''); // second, fatal import

  assert.equal(el['import-summary'].hidden, false, 'the new fatal error must be visible');
  assert.match(el['import-summary'].innerHTML, /empty/i);
  assert.equal(el['app-body'].hidden, false, 'previously loaded contacts must still be shown, not hidden');
  assert.equal(el['contacts-count'].textContent, '1', 'the previously loaded contact must be preserved, not wiped');
});

test('app: a fatal import (missing required column) on a fresh load surfaces the specific reason', function () {
  var el = bootApp();

  fireFileChange(el, 'contact_id,lifecycle_stage\nC1,lead');

  assert.equal(el['import-summary'].hidden, false);
  assert.match(el['import-summary'].innerHTML, /missing required column/i);
});
