(function installConnectorEngine(root) {
  'use strict';

  const PROVIDER_CATALOG = [
    {
      id: 'apricot360',
      name: 'Bonterra Apricot 360',
      category: 'Case management',
      sourceLabel: 'Apricot form ID',
      recordLabel: 'Apricot record ID',
      readiness: 'demo-tested',
    },
    {
      id: 'salesforce_nonprofit',
      name: 'Salesforce / Agentforce Nonprofit',
      category: 'CRM and case management',
      sourceLabel: 'Object or dataset key',
      recordLabel: 'Client record ID',
      readiness: 'adapter-required',
    },
    {
      id: 'bitfocus_clarity',
      name: 'Bitfocus Clarity Human Services',
      category: 'HMIS',
      sourceLabel: 'Client resource key',
      recordLabel: 'Clarity client ID',
      readiness: 'adapter-required',
    },
    {
      id: 'wellsky_community_services',
      name: 'WellSky Community Services / ServicePoint',
      category: 'HMIS',
      sourceLabel: 'Client resource key',
      recordLabel: 'Community Services client ID',
      readiness: 'adapter-required',
    },
    {
      id: 'eccovia_clienttrack',
      name: 'Eccovia ClientTrack',
      category: 'HMIS and case management',
      sourceLabel: 'Client resource key',
      recordLabel: 'ClientTrack client ID',
      readiness: 'adapter-required',
    },
    {
      id: 'caseworthy',
      name: 'CaseWorthy',
      category: 'HMIS and case management',
      sourceLabel: 'Form or resource key',
      recordLabel: 'CaseWorthy client ID',
      readiness: 'adapter-required',
    },
    {
      id: 'foothold_awards',
      name: 'Foothold AWARDS',
      category: 'Human services and EHR',
      sourceLabel: 'Client resource key',
      recordLabel: 'AWARDS client ID',
      readiness: 'adapter-required',
    },
    {
      id: 'bonterra_eto',
      name: 'Bonterra ETO',
      category: 'Impact and case management',
      sourceLabel: 'TouchPoint or resource key',
      recordLabel: 'ETO participant ID',
      readiness: 'adapter-required',
    },
  ];

  const CANONICAL_FIELDS = [
    { key: 'firstName', label: 'First name', category: 'Identity', aliases: ['first name', 'given name', 'client first name'] },
    { key: 'middleName', label: 'Middle name', category: 'Identity', aliases: ['middle name', 'client middle name'] },
    { key: 'lastName', label: 'Last name', category: 'Identity', aliases: ['last name', 'family name', 'surname', 'client last name'] },
    { key: 'dateOfBirth', label: 'Date of birth', category: 'Identity', aliases: ['date of birth', 'birth date', 'dob'] },
    { key: 'ssn', label: 'Social Security number', category: 'Identity', sensitive: true, aliases: ['social security number', 'ssn'] },
    { key: 'email', label: 'Email', category: 'Contact', aliases: ['email', 'email address', 'primary email'] },
    { key: 'phone', label: 'Phone', category: 'Contact', aliases: ['phone', 'phone number', 'mobile phone', 'cell phone'] },
    { key: 'addressLine1', label: 'Street address', category: 'Address', aliases: ['street address', 'address line 1', 'residential address', 'home address'] },
    { key: 'addressLine2', label: 'Apartment or unit', category: 'Address', aliases: ['address line 2', 'apartment', 'unit', 'suite'] },
    { key: 'city', label: 'City', category: 'Address', aliases: ['city', 'residential city', 'home city'] },
    { key: 'state', label: 'State', category: 'Address', aliases: ['state', 'residential state', 'home state'] },
    { key: 'county', label: 'County', category: 'Address', aliases: ['county', 'residential county'] },
    { key: 'postalCode', label: 'ZIP code', category: 'Address', aliases: ['zip code', 'postal code', 'zip'] },
    { key: 'country', label: 'Country', category: 'Address', aliases: ['country', 'residential country', 'home country'] },
    { key: 'mailingDifferent', label: 'Mailing address differs', category: 'Address', aliases: ['mailing address different', 'different mailing address', 'mailing different'] },
    { key: 'gender', label: 'Gender', category: 'Demographics', aliases: ['gender', 'sex'] },
    { key: 'ethnicity', label: 'Ethnicity', category: 'Demographics', aliases: ['ethnicity', 'race ethnicity'] },
    { key: 'primaryLanguage', label: 'Primary language', category: 'Demographics', aliases: ['primary language', 'preferred language', 'language'] },
    { key: 'maritalStatus', label: 'Marital status', category: 'Demographics', aliases: ['marital status'] },
    { key: 'specialNeeds', label: 'Special needs or disability', category: 'Demographics', aliases: ['special needs', 'disability status', 'disabled'] },
    { key: 'farmWorker', label: 'Farm worker', category: 'Demographics', aliases: ['farm worker', 'farmworker', 'migrant worker'] },
    { key: 'pregnant', label: 'Pregnancy', category: 'Demographics', aliases: ['pregnant', 'pregnancy status'] },
    { key: 'preferredContact', label: 'Preferred contact method', category: 'Contact', aliases: ['preferred contact method', 'contact preference', 'best way to contact'] },
    { key: 'housingStatus', label: 'Housing status', category: 'Household and eligibility', aliases: ['housing status', 'homelessness status', 'experiencing homelessness'] },
    { key: 'householdSize', label: 'Household size', category: 'Household and eligibility', aliases: ['household size', 'people in household', 'number in household'] },
    { key: 'immigrationStatus', label: 'Immigration or citizenship status', category: 'Household and eligibility', sensitive: true, aliases: ['immigration status', 'citizenship status'] },
    { key: 'income', label: 'Monthly household income', category: 'Household and eligibility', sensitive: true, aliases: ['monthly household income', 'monthly income', 'gross income'] },
    { key: 'childcare', label: 'Pays for childcare', category: 'Household and eligibility', aliases: ['pays for childcare', 'childcare expenses', 'child care expenses'] },
    { key: 'unemployment', label: 'Unemployment benefits', category: 'Household and eligibility', aliases: ['unemployment benefits', 'receives unemployment'] },
    { key: 'businessName', label: 'Business legal name', category: 'Business', aliases: ['business legal name', 'legal business name', 'business name'] },
    { key: 'ein', label: 'Employer Identification Number', category: 'Business', sensitive: true, aliases: ['employer identification number', 'ein', 'federal tax id'] },
    { key: 'businessType', label: 'Business type', category: 'Business', aliases: ['business type', 'entity type', 'legal structure'] },
    { key: 'dba', label: 'Doing business as', category: 'Business', aliases: ['doing business as', 'dba'] },
    { key: 'businessAddressLine1', label: 'Business street address', category: 'Business', aliases: ['business street address', 'business address', 'company address'] },
    { key: 'businessAddressLine2', label: 'Business suite or unit', category: 'Business', aliases: ['business address line 2', 'business suite', 'company suite'] },
    { key: 'businessCity', label: 'Business city', category: 'Business', aliases: ['business city', 'company city'] },
    { key: 'businessState', label: 'Business state', category: 'Business', aliases: ['business state', 'company state'] },
    { key: 'businessPostalCode', label: 'Business ZIP code', category: 'Business', aliases: ['business zip code', 'business postal code', 'company zip'] },
    { key: 'businessPhone', label: 'Business phone', category: 'Business', aliases: ['business phone', 'company phone'] },
    { key: 'businessEmail', label: 'Business email', category: 'Business', aliases: ['business email', 'company email'] },
    { key: 'incorporationDate', label: 'Formation date', category: 'Business', aliases: ['formation date', 'date of formation', 'incorporation date'] },
    { key: 'stateOfFormation', label: 'State of formation', category: 'Business', aliases: ['state of formation', 'state of incorporation', 'formation state'] },
  ];

  const FORBIDDEN_CONFIG_KEYS = /secret|password|access.?token|refresh.?token|api.?key|credential/i;

  function normalize(value) {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function providerDefinition(providerId) {
    return PROVIDER_CATALOG.find((provider) => provider.id === providerId) || null;
  }

  function sourceId(field) {
    const explicit = [field?.fieldId, field?.field_id].find((value) => value !== undefined && value !== null && String(value).trim());
    if (explicit !== undefined) return String(explicit).trim();
    const numericId = Number(field?.id);
    return Number.isInteger(numericId) && numericId > 0 ? `field_${numericId}` : String(field?.id ?? '').trim();
  }

  function normalizeSchemaFields(payload) {
    const values = Array.isArray(payload) ? payload : payload?.fields || payload?.data || [];
    return values.map((field) => ({
      id: sourceId(field),
      label: String(field?.label ?? field?.attributes?.label ?? '').trim(),
      type: String(field?.type ?? field?.field_type ?? field?.fieldType ?? '').trim(),
      required: Boolean(field?.required ?? field?.is_required),
      referenceTag: String(field?.referenceTag ?? field?.reference_tag ?? '').trim(),
    })).filter((field) => field.id && field.label);
  }

  function matchScore(canonical, field) {
    const label = normalize(field.label);
    const reference = normalize(field.referenceTag);
    const key = normalize(canonical.key);
    const aliases = canonical.aliases.map(normalize);
    if (reference === key || reference === normalize(canonical.label)) return 110;
    if (aliases.includes(label)) return 100;
    if (aliases.includes(reference)) return 95;
    const tokenMatch = aliases.some((alias) => {
      const tokens = alias.split(' ');
      return tokens.length > 1 && tokens.every((token) => label.split(' ').includes(token));
    });
    return tokenMatch ? 70 : 0;
  }

  function suggestMappings(schemaPayload, existing = {}) {
    const fields = normalizeSchemaFields(schemaPayload);
    const used = new Set(Object.values(existing).filter(Boolean).map(String));
    const mappings = { ...existing };
    CANONICAL_FIELDS.forEach((canonical) => {
      if (mappings[canonical.key]) return;
      const ranked = fields
        .filter((field) => !used.has(field.id))
        .map((field) => ({ field, score: matchScore(canonical, field) }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);
      if (!ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)) return;
      mappings[canonical.key] = ranked[0].field.id;
      used.add(ranked[0].field.id);
    });
    return mappings;
  }

  function validateBackendUrl(value) {
    let url;
    try {
      url = new URL(String(value || ''));
    } catch {
      throw new Error('Enter a valid connector service URL.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error('Connector services must use HTTPS. HTTP is allowed only for localhost development.');
    }
    if (url.username || url.password) throw new Error('Do not place credentials in the connector service URL.');
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  }

  function sanitizeConfig(input = {}) {
    Object.keys(input).forEach((key) => {
      if (FORBIDDEN_CONFIG_KEYS.test(key)) throw new Error('Credentials and tokens must never be stored in the extension.');
    });
    const provider = String(input.provider || 'apricot360').trim();
    const providerInfo = providerDefinition(provider);
    if (!providerInfo) throw new Error('Choose a supported data-source type.');
    const sourceId = String(input.sourceId ?? input.formId ?? '').trim();
    const connectionId = String(input.connectionId || '').trim();
    const organizationName = String(input.organizationName || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/.test(connectionId)) throw new Error('Enter a valid connection ID.');
    if (!organizationName) throw new Error('Enter the organization name.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(sourceId)) throw new Error(`Enter a valid ${providerInfo.sourceLabel.toLowerCase()}.`);
    if (provider === 'apricot360' && (!/^\d+$/.test(sourceId) || Number(sourceId) < 1)) throw new Error('Enter a positive Apricot form ID.');
    return {
      mode: 'managed',
      provider,
      backendUrl: validateBackendUrl(input.backendUrl),
      connectionId,
      organizationName,
      sourceId,
      formId: provider === 'apricot360' ? Number(sourceId) : undefined,
      mappings: Object.fromEntries(Object.entries(input.mappings || {}).filter(([key, value]) =>
        CANONICAL_FIELDS.some((field) => field.key === key) && String(value || '').trim()).map(([key, value]) => [key, String(value)])),
      mappingVersion: Number(input.mappingVersion) || 1,
      maxAgeDays: Math.min(365, Math.max(1, Number(input.maxAgeDays) || 30)),
    };
  }

  function validateMappings(configInput, schemaPayload) {
    const config = sanitizeConfig(configInput);
    const fields = normalizeSchemaFields(schemaPayload);
    const known = new Set(fields.map((field) => field.id));
    const selected = Object.values(config.mappings);
    if (selected.length < 2) throw new Error('Map at least two labeled source fields before saving.');
    if (new Set(selected).size !== selected.length) throw new Error('Each source field can map to only one destination field.');
    const unknown = selected.find((id) => !known.has(id));
    if (unknown) throw new Error(`Mapped field ${unknown} is not present in the confirmed schema.`);
    return config;
  }

  function unwrapValue(value) {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.map(unwrapValue).filter((item) => item !== undefined).join(', ');
    if (typeof value === 'object') return value.value ?? value.label ?? value.name;
    return value;
  }

  function recordData(payload) {
    const candidate = payload?.record ?? (Array.isArray(payload?.data) ? payload.data[0] : payload?.data) ?? payload;
    return candidate && typeof candidate === 'object' ? candidate : null;
  }

  function mapRecord(payload, configInput, schemaPayload, retrievedAt = new Date().toISOString()) {
    const config = validateMappings(configInput, schemaPayload);
    const schema = normalizeSchemaFields(schemaPayload);
    const schemaById = new Map(schema.map((field) => [field.id, field]));
    const raw = recordData(payload);
    if (!raw) return { found: false, record: null, provenance: {} };
    const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : raw;
    const values = {};
    const provenance = {};
    Object.entries(config.mappings).forEach(([canonicalKey, fieldId]) => {
      const value = unwrapValue(attributes[fieldId] ?? raw.fields?.[fieldId]);
      if (value === undefined || value === null || value === '') return;
      const field = schemaById.get(fieldId);
      values[canonicalKey] = value;
      provenance[canonicalKey] = { sourceFieldId: fieldId, sourceLabel: field.label };
    });
    const recordId = String(raw.id ?? attributes.record_id ?? attributes.id ?? '').trim();
    const sourceModifiedAt = attributes.mod_time ?? attributes.modifiedAt ?? raw.modifiedAt ?? null;
    const retrievedMs = Date.parse(retrievedAt);
    const sourceModifiedMs = Date.parse(sourceModifiedAt);
    const ageMs = Number.isFinite(retrievedMs) && Number.isFinite(sourceModifiedMs) ? retrievedMs - sourceModifiedMs : null;
    const freshness = ageMs === null ? 'unknown' : ageMs > config.maxAgeDays * 86400000 ? 'stale' : 'fresh';
    const stale = freshness !== 'fresh';
    return {
      found: Boolean(recordId && Object.keys(values).length),
      record: recordId ? {
        record_id: recordId,
        ...values,
        _connector: {
          provider: config.provider,
          connectionId: config.connectionId,
          organizationName: config.organizationName,
          sourceId: config.sourceId,
          ...(config.formId ? { formId: config.formId } : {}),
          retrievedAt,
          sourceModifiedAt,
          stale,
          freshness,
          maxAgeDays: config.maxAgeDays,
          mappingVersion: config.mappingVersion,
          provenance,
        },
      } : null,
      provenance,
      stale,
      freshness,
    };
  }

  const api = {
    CANONICAL_FIELDS,
    PROVIDER_CATALOG,
    mapRecord,
    normalize,
    normalizeSchemaFields,
    providerDefinition,
    sanitizeConfig,
    suggestMappings,
    validateBackendUrl,
    validateMappings,
  };

  root.NavaConnectorEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
