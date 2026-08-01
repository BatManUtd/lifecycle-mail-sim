/* app.js - UI wiring for lifecycle-mail-sim. Browser-only; uses the
 * dependency-free LifecycleCSV / LifecycleEngine / LifecycleSampleData
 * globals loaded via plain <script> tags before this file. */
(function () {
  'use strict';

  var CSVLib = window.LifecycleCSV;
  var Engine = window.LifecycleEngine;
  var SampleData = window.LifecycleSampleData;

  var STATE = {
    contacts: [],
    customFields: [],
    campaigns: [],
    importErrors: [],
    importSkipped: 0,
    deadCampaignIds: [],
    globalCapEnabled: false,
    globalCapMax: 1,
    simResult: null,
    editingCampaignId: null
  };

  var el = {}; // populated in init() with commonly-used elements

  function q(id) { return document.getElementById(id); }

  function init() {
    [
      'btn-load-sample', 'btn-load-sample-2', 'csv-file-input', 'csv-file-input-2', 'btn-reset',
      'empty-state', 'app-body', 'import-summary',
      'contacts-count', 'contacts-tbody',
      'campaigns-count', 'campaigns-list', 'btn-new-campaign',
      'global-cap-enabled', 'global-cap-max',
      'sim-start-date', 'sim-end-date', 'btn-simulate',
      'results-panel', 'results-summary', 'dead-campaigns-summary', 'results-list',
      'btn-copy-results', 'btn-export-results',
      'campaign-modal', 'campaign-modal-title', 'campaign-form', 'campaign-form-errors',
      'cf-id', 'cf-name', 'cf-type', 'cf-conditions', 'btn-add-condition',
      'cf-freq-max', 'cf-freq-days', 'cf-priority',
      'btn-delete-campaign', 'btn-cancel-campaign', 'toast'
      // Note: [a-zA-Z0-9] (not just [a-z]) so ids with a trailing digit segment, e.g.
      // 'btn-load-sample-2' -> 'btnLoadSample2', convert correctly. With [a-z] only,
      // '-2' was left as a literal hyphen ('btnLoadSample-2'), so el.btnLoadSample2
      // below was undefined and threw, aborting init() before any of the listeners
      // after it (including the CSV file-input 'change' handlers) were ever attached.
    ].forEach(function (id) { el[id.replace(/-([a-zA-Z0-9])/g, function (_, c) { return c.toUpperCase(); })] = q(id); });

    Engine.CAMPAIGN_TYPES.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      el.cfType.appendChild(opt);
    });

    el.btnLoadSample.addEventListener('click', loadSample);
    el.btnLoadSample2.addEventListener('click', loadSample);
    el.csvFileInput.addEventListener('change', function (e) { handleFile(e.target.files[0]); e.target.value = ''; });
    el.csvFileInput2.addEventListener('change', function (e) { handleFile(e.target.files[0]); e.target.value = ''; });
    el.btnReset.addEventListener('click', resetAll);

    el.btnNewCampaign.addEventListener('click', function () { openCampaignModal(null); });
    el.btnAddCondition.addEventListener('click', function () { addConditionRow({}); });
    el.campaignForm.addEventListener('submit', onSaveCampaign);
    el.btnCancelCampaign.addEventListener('click', closeCampaignModal);
    el.btnDeleteCampaign.addEventListener('click', onDeleteCampaign);

    el.globalCapEnabled.addEventListener('change', function () { STATE.globalCapEnabled = el.globalCapEnabled.checked; });
    el.globalCapMax.addEventListener('change', function () { STATE.globalCapMax = Math.max(1, parseInt(el.globalCapMax.value, 10) || 1); });

    el.btnSimulate.addEventListener('click', runSimulate);
    el.btnCopyResults.addEventListener('click', copyResultsCSV);
    el.btnExportResults.addEventListener('click', downloadResultsCSV);

    renderAll();
  }

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------
  function loadSample() {
    ingestContactsCSV(SampleData.SAMPLE_CONTACTS_CSV);
    STATE.campaigns = JSON.parse(JSON.stringify(SampleData.SAMPLE_CAMPAIGNS));
    el.simStartDate.value = SampleData.SAMPLE_SIMULATE_DATE;
    el.simEndDate.value = '';
    recomputeDeadCampaigns();
    renderAll();
    runSimulate();
    toast('Sample data loaded: ' + STATE.contacts.length + ' contacts, ' + STATE.campaigns.length + ' campaigns.');
  }

  function handleFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) { ingestContactsCSV(String(e.target.result)); recomputeDeadCampaigns(); renderAll(); };
    reader.onerror = function () { toast('Could not read file.'); };
    reader.readAsText(file);
  }

  function ingestContactsCSV(text) {
    var result = CSVLib.validateContacts(text);
    if (result.fatal) {
      // A fatal error (empty file, missing required column) must never silently wipe
      // previously loaded contacts/campaigns/results — only the error panel updates.
      // renderAll() (called by every caller of this function) always re-renders the
      // import summary regardless of whether contacts are loaded, so the new error is
      // shown alongside whatever was already on screen.
      STATE.importErrors = result.errors;
      STATE.importSkipped = 0;
      return;
    }
    STATE.contacts = result.contacts;
    STATE.customFields = result.customFields || [];
    STATE.importErrors = result.errors;
    STATE.importSkipped = result.skippedCount;
    STATE.simResult = null;
  }

  function resetAll() {
    STATE.contacts = []; STATE.customFields = []; STATE.campaigns = [];
    STATE.importErrors = []; STATE.importSkipped = 0; STATE.deadCampaignIds = []; STATE.simResult = null;
    renderAll();
  }

  function recomputeDeadCampaigns() {
    STATE.deadCampaignIds = STATE.contacts.length ? Engine.findDeadCampaigns(STATE.contacts, STATE.campaigns) : [];
  }

  // ---------------------------------------------------------------------
  // Rendering: shell
  // ---------------------------------------------------------------------
  function renderAll() {
    var hasData = STATE.contacts.length > 0;
    el.emptyState.hidden = hasData;
    el.appBody.hidden = !hasData;
    el.btnReset.hidden = !hasData;
    // Import errors must render independent of hasData: a fatal import error panel must
    // stay visible even when there is no contact data (or when previously loaded data is
    // being preserved through a failed re-import) — never hidden as a side effect of
    // #app-body being hidden.
    renderImportSummary();
    if (!hasData) return;

    renderContactsTable();
    renderCampaignsList();
    if (STATE.simResult) renderResults(); else el.resultsPanel.hidden = true;
  }

  function renderImportSummary() {
    var hasErrors = STATE.importErrors && STATE.importErrors.length > 0;
    el.importSummary.hidden = !hasErrors;
    if (!hasErrors) return;
    var html = '<h2>Import notes <span class="badge">' + STATE.importErrors.length + '</span></h2>';
    if (STATE.importSkipped > 0) {
      html += '<p class="section-note">' + STATE.importSkipped + ' row(s) were skipped entirely (not silently dropped — reasons below). Other rows were kept but had a flagged field treated as missing.</p>';
    }
    html += '<ul class="import-errors">' + STATE.importErrors.map(function (e) {
      return '<li>Row ' + e.row + ': ' + escapeHtml(e.reason) + '</li>';
    }).join('') + '</ul>';
    el.importSummary.innerHTML = html;
  }

  function renderContactsTable() {
    el.contactsCount.textContent = String(STATE.contacts.length);
    el.contactsTbody.innerHTML = STATE.contacts.map(function (c) {
      return '<tr>' +
        '<td>' + escapeHtml(c.contact_id) + '</td>' +
        '<td>' + escapeHtml(c.lifecycle_stage || '—') + '</td>' +
        '<td>' + escapeHtml(c.plan || '—') + '</td>' +
        '<td>' + escapeHtml(c.renewal_date || '—') + '</td>' +
        '<td>' + escapeHtml(c.payment_status || '—') + '</td>' +
        '<td>' + escapeHtml(c.last_email_sent_date || '—') + '</td>' +
        '<td><span class="pill ' + (c.unsubscribed ? 'pill-yes">Yes' : 'pill-no">No') + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderCampaignsList() {
    el.campaignsCount.textContent = String(STATE.campaigns.length);
    el.campaignsList.innerHTML = STATE.campaigns.map(function (c) {
      var isDead = STATE.deadCampaignIds.indexOf(c.id) !== -1;
      var conds = c.conditions.map(function (cond) {
        return '<code>' + escapeHtml(cond.field) + ' ' + escapeHtml(cond.operator) +
          (['is_empty', 'is_not_empty'].indexOf(cond.operator) === -1 ? ' "' + escapeHtml(cond.value) + '"' : '') + '</code>';
      }).join(' AND ');
      return '<div class="campaign-card' + (isDead ? ' dead' : '') + '">' +
        '<div class="campaign-card-head"><h3>' + escapeHtml(c.name) + '</h3><span class="campaign-type-tag">' + c.type.replace('_', ' ') + '</span></div>' +
        (isDead ? '<div class="dead-tag">&#9888; Dead campaign — matches zero imported contacts</div>' : '') +
        '<div class="campaign-conditions">' + conds + '</div>' +
        '<div class="campaign-meta">Cap: ' + c.frequencyCapMax + ' per ' + c.frequencyCapDays + ' day(s) &nbsp;·&nbsp; Priority: ' + c.priority + '</div>' +
        '<div class="campaign-actions"><button class="btn btn-secondary btn-sm" data-edit="' + c.id + '">Edit</button></div>' +
        '</div>';
    }).join('') || '<p class="section-note">No campaigns yet.</p>';

    el.campaignsList.querySelectorAll('[data-edit]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var c = STATE.campaigns.find(function (x) { return x.id === btn.getAttribute('data-edit'); });
        openCampaignModal(c);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Campaign builder modal
  // ---------------------------------------------------------------------
  function fieldOptions() {
    return Engine.CONTACT_FIELDS.concat(STATE.customFields || []);
  }

  function openCampaignModal(campaign) {
    STATE.editingCampaignId = campaign ? campaign.id : null;
    el.campaignModalTitle.textContent = campaign ? 'Edit Campaign' : 'New Campaign';
    el.cfId.value = campaign ? campaign.id : '';
    el.cfName.value = campaign ? campaign.name : '';
    el.cfType.value = campaign ? campaign.type : Engine.CAMPAIGN_TYPES[0];
    el.cfFreqMax.value = campaign ? campaign.frequencyCapMax : 1;
    el.cfFreqDays.value = campaign ? campaign.frequencyCapDays : 7;
    el.cfPriority.value = campaign ? campaign.priority : 10;
    el.btnDeleteCampaign.hidden = !campaign;
    el.campaignFormErrors.hidden = true;
    el.cfConditions.innerHTML = '';
    (campaign ? campaign.conditions : [{}]).forEach(addConditionRow);
    el.campaignModal.hidden = false;
  }

  function closeCampaignModal() { el.campaignModal.hidden = true; }

  function addConditionRow(cond) {
    var row = document.createElement('div');
    row.className = 'condition-row';
    var fieldSel = '<select class="cond-field">' + fieldOptions().map(function (f) {
      return '<option value="' + escapeHtml(f) + '"' + (cond.field === f ? ' selected' : '') + '>' + escapeHtml(f) + '</option>';
    }).join('') + '</select>';
    var opSel = '<select class="cond-op">' + Engine.OPERATORS.map(function (o) {
      return '<option value="' + o + '"' + (cond.operator === o ? ' selected' : '') + '>' + o.replace(/_/g, ' ') + '</option>';
    }).join('') + '</select>';
    row.innerHTML = fieldSel + opSel +
      '<input type="text" class="cond-val" placeholder="value (or {{today}} for dates)" value="' + escapeHtml(cond.value || '') + '" />' +
      '<button type="button" class="btn btn-ghost btn-sm" title="Remove condition">&times;</button>';
    row.querySelector('button').addEventListener('click', function () { row.remove(); });
    el.cfConditions.appendChild(row);
  }

  function collectFormCampaign() {
    var conditions = Array.prototype.map.call(el.cfConditions.querySelectorAll('.condition-row'), function (row) {
      return {
        field: row.querySelector('.cond-field').value,
        operator: row.querySelector('.cond-op').value,
        value: row.querySelector('.cond-val').value.trim()
      };
    });
    return {
      id: el.cfId.value || 'camp_' + Date.now().toString(36),
      name: el.cfName.value.trim(),
      type: el.cfType.value,
      conditions: conditions,
      frequencyCapMax: parseInt(el.cfFreqMax.value, 10),
      frequencyCapDays: parseInt(el.cfFreqDays.value, 10),
      priority: parseInt(el.cfPriority.value, 10)
    };
  }

  function onSaveCampaign(e) {
    e.preventDefault();
    var campaign = collectFormCampaign();
    var errs = Engine.validateCampaign(campaign, STATE.campaigns);
    if (errs.length) {
      el.campaignFormErrors.hidden = false;
      el.campaignFormErrors.innerHTML = errs.map(function (x) { return escapeHtml(x); }).join('<br/>');
      return;
    }
    var existingIdx = STATE.campaigns.findIndex(function (c) { return c.id === campaign.id; });
    if (existingIdx !== -1) STATE.campaigns[existingIdx] = campaign; else STATE.campaigns.push(campaign);
    recomputeDeadCampaigns();
    closeCampaignModal();
    renderAll();
    toast('Campaign saved.');
  }

  function onDeleteCampaign() {
    STATE.campaigns = STATE.campaigns.filter(function (c) { return c.id !== STATE.editingCampaignId; });
    recomputeDeadCampaigns();
    closeCampaignModal();
    renderAll();
    toast('Campaign deleted.');
  }

  // ---------------------------------------------------------------------
  // Simulate + results
  // ---------------------------------------------------------------------
  function runSimulate() {
    if (!STATE.contacts.length) { toast('Load contacts first.'); return; }
    var start = el.simStartDate.value;
    if (!start) { toast('Choose a start date.'); return; }
    var end = el.simEndDate.value || start;
    STATE.simResult = Engine.simulate(STATE.contacts, STATE.campaigns, {
      startDate: start, endDate: end,
      globalDailyCapEnabled: STATE.globalCapEnabled,
      globalDailyCapMax: STATE.globalCapMax
    });
    el.resultsPanel.hidden = false;
    renderResults();
  }

  function renderResults() {
    var r = STATE.simResult;
    var totalSent = 0, totalBlocked = 0, conflictContacts = 0, noActivity = r.noActivityContactIds.length;
    r.results.forEach(function (row) {
      totalSent += row.sent.length; totalBlocked += row.blocked.length;
      if (row.conflicts.length) conflictContacts++;
    });

    el.resultsSummary.innerHTML =
      statTile('sent', totalSent, 'Emails sent') +
      statTile('blocked', totalBlocked, 'Blocked') +
      statTile('conflict', conflictContacts, 'Contacts w/ conflict') +
      statTile('noactivity', noActivity, 'No activity');

    el.deadCampaignsSummary.innerHTML = STATE.deadCampaignIds.length
      ? '<div class="dead-campaign-banner">&#9888; ' + STATE.deadCampaignIds.length + ' dead campaign(s) — matches zero imported contacts: ' +
        STATE.deadCampaignIds.map(function (id) {
          var c = STATE.campaigns.find(function (x) { return x.id === id; });
          return escapeHtml(c ? c.name : id);
        }).join(', ') + '</div>'
      : '';

    el.resultsList.innerHTML = r.results.map(renderContactGroup).join('');
    el.resultsList.querySelectorAll('.contact-group-head').forEach(function (head) {
      head.addEventListener('click', function () { head.parentElement.classList.toggle('open'); });
    });
  }

  function statTile(cls, num, label) {
    return '<div class="stat-tile ' + cls + '"><span class="num">' + num + '</span><span class="lbl">' + label + '</span></div>';
  }

  function renderContactGroup(row) {
    var tags = [];
    if (row.sent.length) tags.push('<span class="tag tag-sent">' + row.sent.length + ' sent</span>');
    if (row.blocked.length) tags.push('<span class="tag tag-blocked">' + row.blocked.length + ' blocked</span>');
    if (row.conflicts.length) tags.push('<span class="tag tag-conflict">conflict</span>');
    if (!row.sent.length && !row.blocked.length) tags.push('<span class="tag tag-none">no activity</span>');

    var body = '';
    if (!row.sent.length && !row.blocked.length) {
      body = '<p class="section-note">This contact matched zero campaigns across the simulated date(s). The tool ran correctly — there is simply nothing to send.</p>';
    } else {
      var events = row.sent.map(function (s) { return { kind: 'sent', d: s }; })
        .concat(row.blocked.map(function (b) { return { kind: 'blocked', d: b }; }))
        .sort(function (a, b) { return a.d.date.localeCompare(b.d.date); });

      body += '<table><thead><tr><th>Date</th><th>Status</th><th>Campaign</th><th>Type</th><th>Priority / Rule</th><th>Why</th></tr></thead><tbody>';
      events.forEach(function (ev) {
        if (ev.kind === 'sent') {
          body += '<tr class="row-sent"><td>' + ev.d.date + '</td><td><span class="tag tag-sent">SENT</span></td><td>' + escapeHtml(ev.d.campaign_name) +
            '</td><td>' + ev.d.campaign_type + '</td><td>priority ' + ev.d.priority + ' (order ' + ev.d.order + ')</td><td>' + escapeHtml(ev.d.matched_conditions.join(' AND ')) + '</td></tr>';
        } else {
          body += '<tr class="row-blocked"><td>' + ev.d.date + '</td><td><span class="tag tag-blocked">BLOCKED</span></td><td>' + escapeHtml(ev.d.campaign_name) +
            '</td><td>' + ev.d.campaign_type + '</td><td>' + ev.d.rule + '</td><td>' + escapeHtml(ev.d.reason) + '</td></tr>';
        }
      });
      body += '</tbody></table>';

      row.conflicts.forEach(function (c) {
        body += '<div class="conflict-note">&#9888; ' + c.date + ': ' + c.campaigns.length + ' campaigns fired the same day (' +
          c.campaigns.map(function (x) { return escapeHtml(x.name) + ' [p' + x.priority + ']'; }).join(' → ') +
          '). ' + escapeHtml(c.tie_break_reason) + '</div>';
      });
    }

    return '<div class="contact-group">' +
      '<div class="contact-group-head"><span><span class="chevron">&#9656;</span> <span class="cg-id">' + escapeHtml(row.contact.contact_id) + '</span></span>' +
      '<span class="cg-tags">' + tags.join('') + '</span></div>' +
      '<div class="contact-group-body">' + body + '</div></div>';
  }

  // ---------------------------------------------------------------------
  // Export / copy
  // ---------------------------------------------------------------------
  function downloadResultsCSV() {
    if (!STATE.simResult) return;
    var csv = Engine.resultsToCSV(STATE.simResult);
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lifecycle-mail-sim-results.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function copyResultsCSV() {
    if (!STATE.simResult) return;
    var csv = Engine.resultsToCSV(STATE.simResult);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(csv).then(function () { toast('Results copied as CSV.'); }, function () { fallbackCopy(csv); });
    } else {
      fallbackCopy(csv);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Results copied as CSV.'); } catch (e) { toast('Copy failed — use Download CSV instead.'); }
    document.body.removeChild(ta);
  }

  // ---------------------------------------------------------------------
  // Misc
  // ---------------------------------------------------------------------
  var toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
