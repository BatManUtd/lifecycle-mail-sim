/**
 * sample-data.js - bundled sample dataset used by the "Load Sample Data"
 * button. Embedded as a JS string/object (rather than fetched) so the app
 * works when index.html is opened directly from disk via file:// with zero
 * network calls and no local server.
 *
 * The same contact rows are also checked into data/sample_contacts.csv for
 * inspection and for re-import through the CSV upload path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LifecycleSampleData = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SAMPLE_CONTACTS_CSV = [
    'contact_id,lifecycle_stage,plan,renewal_date,payment_status,last_email_sent_date,unsubscribed,region',
    'C001,lead,free,,none,2026-07-26,false,NA',
    'C002,lead,free,,none,,false,NA',
    'C003,lead,free,,none,2026-06-01,true,EU',
    'C004,trial,pro,,none,,false,NA',
    'C005,trial,free,,none,2026-07-27,false,APAC',
    'C006,customer,pro,2026-05-01,paid,,false,NA',
    'C007,customer,pro,2026-08-05,overdue,2026-05-01,false,EU',
    'C008,customer,pro,2026-08-10,paid,2026-04-01,false,NA',
    'C009,customer,enterprise,2026-08-20,overdue,,false,APAC',
    'C010,churn_risk,free,,pending,,false,NA',
    'C011,evangelist,enterprise,,none,,false,EU',
    'C012,lead,pro,,none,2026-07-10,false,NA',
    'C013,trial,free,,none,2026-07-29,false,APAC',
    'C014,customer,free,2026-08-03,overdue,,true,NA',
    'C015,lead,free,,none,07/30/2026,false,EU',
    'C016,trial,enterprise,,none,,false,NA',
    'C017,customer,pro,2026-09-15,overdue,,false,APAC',
    'C018,lead,free,,none,,true,NA',
    'C019,customer,enterprise,2026-08-25,pending,2026-07-20,false,EU',
    'C020,trial,pro,,none,2026-07-25,false,APAC'
  ].join('\n') + '\n';

  var SAMPLE_SIMULATE_DATE = '2026-07-30';

  var SAMPLE_CAMPAIGNS = [
    {
      id: 'camp_invite',
      name: 'New Lead Welcome Invite',
      type: 'invite',
      conditions: [
        { field: 'lifecycle_stage', operator: 'equals', value: 'lead' }
      ],
      frequencyCapMax: 1,
      frequencyCapDays: 14,
      priority: 10
    },
    {
      id: 'camp_nurture',
      name: 'Trial Nurture Series',
      type: 'nurture',
      conditions: [
        { field: 'lifecycle_stage', operator: 'equals', value: 'trial' }
      ],
      frequencyCapMax: 3,
      frequencyCapDays: 5,
      priority: 20
    },
    {
      id: 'camp_promo',
      name: 'Quarterly Promo Blast',
      type: 'promo',
      conditions: [
        { field: 'lifecycle_stage', operator: 'equals', value: 'customer' },
        { field: 'plan', operator: 'equals', value: 'pro' }
      ],
      frequencyCapMax: 1,
      frequencyCapDays: 7,
      priority: 30
    },
    {
      id: 'camp_newsletter',
      name: 'Newsletter Monthly Digest',
      type: 'newsletter',
      conditions: [
        { field: 'plan', operator: 'equals', value: 'pro' }
      ],
      frequencyCapMax: 1,
      frequencyCapDays: 30,
      priority: 30
    },
    {
      id: 'camp_payment',
      name: 'Renewal Payment Reminder',
      type: 'payment_reminder',
      conditions: [
        { field: 'lifecycle_stage', operator: 'equals', value: 'customer' },
        { field: 'renewal_date', operator: 'on_or_after', value: '2026-06-01' },
        { field: 'renewal_date', operator: 'on_or_before', value: '2026-08-30' }
      ],
      frequencyCapMax: 2,
      frequencyCapDays: 3,
      priority: 5
    },
    {
      id: 'camp_renewal',
      name: 'Upcoming Renewal Notice',
      type: 'renewal',
      conditions: [
        { field: 'lifecycle_stage', operator: 'equals', value: 'customer' },
        { field: 'renewal_date', operator: 'on_or_after', value: '2026-07-30' }
      ],
      frequencyCapMax: 1,
      frequencyCapDays: 60,
      priority: 15
    }
  ];

  return {
    SAMPLE_CONTACTS_CSV: SAMPLE_CONTACTS_CSV,
    SAMPLE_CAMPAIGNS: SAMPLE_CAMPAIGNS,
    SAMPLE_SIMULATE_DATE: SAMPLE_SIMULATE_DATE
  };
}));
