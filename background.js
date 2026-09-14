import './shared/connector-engine.js';

const connectorEngine = globalThis.NavaConnectorEngine;
const CONNECTOR_STORAGE_KEY = 'nava:connector';

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

function demoConnectorStatus() {
  return {
    mode: 'demo',
    provider: 'bundled-demo-records',
    organizationName: 'Nava fictional test data',
    status: 'ready',
    message: 'Using bundled fictional records. Configure a managed connector to retrieve organization data.',
  };
}

async function storedConnector() {
  const saved = await chrome.storage.local.get(CONNECTOR_STORAGE_KEY);
  return saved[CONNECTOR_STORAGE_KEY] || null;
}

function connectorUrl(config, resource, query = {}) {
  const url = new URL(`${config.backendUrl}/v1/connectors/${encodeURIComponent(config.connectionId)}/${resource}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url.toString();
}

async function connectorRequest(configInput, resource, query = {}) {
  const config = connectorEngine.sanitizeConfig(configInput);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(connectorUrl(config, resource, query), {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Connector service returned ${response.status}.`);
    const payload = await response.json();
    if (payload?.ok === false) throw new Error(payload.error || 'The connector service rejected the request.');
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The connector service did not respond within 12 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverConnector(configInput) {
  const config = connectorEngine.sanitizeConfig(configInput);
  const health = await connectorRequest(config, 'health');
  if (health.provider && health.provider !== 'apricot360') throw new Error('The connector is not an Apricot 360 connection.');
  const authoritativeConfig = {
    ...config,
    organizationName: String(health.organizationName || config.organizationName).trim(),
  };
  const schemaPayload = await connectorRequest(authoritativeConfig, 'schema', { formId: authoritativeConfig.formId });
  const schema = connectorEngine.normalizeSchemaFields(schemaPayload);
  if (!schema.length) throw new Error('The connector returned no labeled fields for that form.');
  return {
    ok: true,
    health: {
      organizationName: health.organizationName || config.organizationName,
      provider: health.provider || config.provider,
    },
    config: authoritativeConfig,
    schema,
    suggestions: connectorEngine.suggestMappings(schema, authoritativeConfig.mappings),
  };
}

async function lookupManagedRecord(recordId, saved) {
  const payload = await connectorRequest(saved.config, `records/${encodeURIComponent(recordId)}`, { formId: saved.config.formId });
  const mapped = connectorEngine.mapRecord(payload, saved.config, saved.schema);
  return {
    ok: mapped.found,
    record: mapped.record,
    provider: saved.config.provider,
    connector: {
      organizationName: saved.config.organizationName,
      retrievedAt: mapped.record?._connector?.retrievedAt,
      stale: Boolean(mapped.stale),
      freshness: mapped.freshness,
      mappedFields: Object.keys(mapped.provenance || {}).length,
    },
    message: mapped.found
      ? mapped.freshness === 'unknown'
        ? 'Record loaded, but the connector did not provide a valid source-modified time.'
        : mapped.stale
          ? `Record loaded, but the source was last updated more than ${saved.config.maxAgeDays} days ago.`
        : 'Record loaded from the managed connector.'
      : 'The connector returned no mapped values for that record ID.',
  };
}

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
  if (message?.type === 'GET_CONNECTOR_STATUS') {
    storedConnector()
      .then((saved) => sendResponse({
        ok: true,
        connector: saved
          ? { ...saved.config, status: 'ready', connectedAt: saved.connectedAt, schemaFieldCount: saved.schema.length }
          : demoConnectorStatus(),
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'DISCOVER_CONNECTOR') {
    discoverConnector(message.config)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'SAVE_CONNECTOR') {
    Promise.resolve().then(async () => {
      const schema = connectorEngine.normalizeSchemaFields(message.schema);
      const config = connectorEngine.validateMappings(message.config, schema);
      const saved = { config, schema, connectedAt: new Date().toISOString() };
      await chrome.storage.local.set({ [CONNECTOR_STORAGE_KEY]: saved });
      return { ok: true, connector: { ...config, status: 'ready', connectedAt: saved.connectedAt, schemaFieldCount: schema.length } };
    })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'RESET_CONNECTOR') {
    chrome.storage.local.remove(CONNECTOR_STORAGE_KEY)
      .then(() => sendResponse({ ok: true, connector: demoConnectorStatus() }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'LOOKUP_RECORD') {
    const recordId = String(message.recordId || '').trim();
    if (!/^\d+$/.test(recordId)) {
      sendResponse({ ok: false, record: null, message: 'Enter a numeric Apricot record ID.' });
      return false;
    }
    storedConnector()
      .then((saved) => {
        if (saved) return lookupManagedRecord(recordId, saved);
        const record = DEMO_RECORDS.find((item) => item.record_id === recordId) || null;
        return {
          ok: Boolean(record),
          record,
          provider: 'bundled-demo-records',
          connector: { organizationName: 'Nava fictional test data', stale: false },
          message: record
            ? 'Fictional demo record loaded.'
            : 'No fictional record matched. Configure a managed connector or paste client JSON.',
        };
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, record: null, error: error.message }));
    return true;
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
