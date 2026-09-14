const DEMO_RECORDS = [
  {
    record_id: '339619',
    participant: {
      name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas II' },
      date_of_birth: '2000-01-02',
      ethnicity: 'Hispanic/Latino',
      gender: 'Female',
      primary_language: 'English',
      special_needs: false,
      marital_status: 'Single parent household',
      farm_worker: false,
    },
    contact_information: {
      preferred_method: null,
      phones: { cell: '777-777-7777' },
      email: 'testnava@email.com',
    },
    address: {
      residential: {
        street: '5556 Test Blvd',
        unit: 'Apt 556',
        city: 'WILDOMAR',
        state: 'California',
        county: 'Riverside',
        zip: '92595',
      },
      mailing: {
        street: '5556 Test Blvd',
        unit: 'Apt 556',
        city: 'WILDOMAR',
        state: 'California',
        county: 'Riverside',
        zip: '92595',
      },
    },
  },
  {
    record_id: '338618',
    participant: {
      name: { first: 'Amelie', middle: 'NAVA', last: 'Thomas I' },
      date_of_birth: '2000-01-01',
      ethnicity: 'Hispanic/Latino',
      gender: 'Female',
      primary_language: 'English',
      special_needs: false,
      marital_status: 'Single parent household',
    },
    contact_information: {
      preferred_method: null,
      phones: { cell: '7777777777' },
      email: 'testnava@email.com',
    },
    address: {
      residential: {
        street: '5555 Test Blvd',
        unit: 'Apt 555',
        city: 'BANNING',
        state: 'CA',
        county: 'Riverside',
        zip: '92220',
      },
      mailing: {
        street: '5555 Test Blvd',
        unit: 'Apt 555',
        city: 'BANNING',
        state: 'CA',
        county: 'Riverside',
        zip: '92220',
      },
    },
  },
  {
    record_id: '339637',
    participant: {
      name: { first: 'Sawyer', middle: 'NAVA', last: 'Thomas XX' },
      date_of_birth: '1954-01-10',
      ethnicity: 'Hispanic/Latino',
      gender: 'Male',
      primary_language: 'Spanish',
      special_needs: false,
      marital_status: 'Other',
    },
    contact_information: {
      preferred_method: null,
      phones: { cell: '7777777777' },
      email: 'testnava@email.com',
    },
    address: {
      residential: {
        street: '5574 Test Blvd',
        unit: 'Apt 574',
        city: 'WILDOMAR',
        state: 'CA',
        county: 'Riverside',
        zip: '92505',
      },
      mailing: {
        street: '5574 Test Blvd',
        unit: 'Apt 574',
        city: 'WILDOMAR',
        state: 'CA',
        county: 'Riverside',
        zip: '92505',
      },
    },
  },
];

const PROGRAMS = {
  calfresh: {
    name: 'CalFresh',
    url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
  },
  medical: {
    name: 'Medi-Cal',
    url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
  },
  wic: {
    name: 'WIC',
    url: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
  },
  calworks: {
    name: 'CalWORKs',
    url: 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en',
  },
  ihss: {
    name: 'IHSS',
    url: 'https://riversideihss.org/Home/IHSS',
  },
};

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`nava:application:${tabId}`).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'LOOKUP_RECORD') {
    const recordId = String(message.recordId || '').trim();
    const record = DEMO_RECORDS.find((item) => item.record_id === recordId) || null;
    sendResponse({
      ok: Boolean(record),
      record,
      provider: 'bundled-demo-records',
      message: record
        ? 'Demo record loaded.'
        : 'This build is not connected to Apricot. Use a bundled demo ID or paste client JSON.',
    });
    return false;
  }

  if (message?.type === 'OPEN_PROGRAMS') {
    const keys = Array.isArray(message.programs) ? message.programs : [];
    Promise.all(
      keys
        .map((key) => PROGRAMS[key])
        .filter(Boolean)
        .map(async (program) => {
          const tab = await chrome.tabs.create({ url: program.url, active: false });
          if (tab.id) {
            await chrome.storage.session.set({
              [`nava:application:${tab.id}`]: {
                tabId: tab.id,
                name: program.name,
                url: program.url,
                status: 'not_started',
                updatedAt: new Date().toISOString(),
              },
            });
          }
          return { tabId: tab.id, name: program.name, url: program.url };
        }),
    )
      .then((opened) => sendResponse({ ok: true, opened }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'GET_PROGRAMS') {
    sendResponse({ ok: true, programs: PROGRAMS });
    return false;
  }

  return false;
});
