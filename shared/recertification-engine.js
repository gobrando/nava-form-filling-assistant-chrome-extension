(function installRecertificationEngine(root) {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const VALID_REQUIREMENT_STATES = new Set(['current', 'confirmed', 'missing', 'stale']);
  const VALID_CONSENT_STATES = new Set(['not_asked', 'invited', 'authorized', 'declined']);
  const VALID_OUTREACH_STATES = new Set(['not_started', 'drafted', 'completed']);

  const REQUIREMENTS = [
    { key: 'contact', label: 'Contact and address', question: 'Are the client’s phone, email, and home and mailing addresses still correct?' },
    { key: 'household', label: 'Household changes', question: 'Has anyone joined or left the household since the last application?' },
    { key: 'income', label: 'Income and employment', question: 'Has income, employment, or benefit income changed?' },
    { key: 'expenses', label: 'Expenses and deductions', question: 'Have rent, utilities, childcare, medical, or other deductible expenses changed?' },
    { key: 'documents', label: 'Supporting documents', question: 'Are current proof documents available for every reported change?' },
  ];

  function dateOnly(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10) === match[0] ? date : null;
  }

  function todayUtc(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return todayUtc();
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  function daysUntil(dueDate, today = new Date()) {
    const due = dateOnly(dueDate);
    if (!due) return null;
    return Math.round((due.getTime() - todayUtc(today).getTime()) / DAY_MS);
  }

  function urgencyFor(days) {
    if (!Number.isFinite(days)) return { key: 'unknown', label: 'Date needs review', order: 5 };
    if (days < 0) return { key: 'overdue', label: `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`, order: 0 };
    if (days === 0) return { key: 'due', label: 'Due today', order: 0 };
    if (days <= 14) return { key: 'urgent', label: `Due in ${days} day${days === 1 ? '' : 's'}`, order: 1 };
    if (days <= 45) return { key: 'soon', label: `Due in ${days} days`, order: 2 };
    if (days <= 90) return { key: 'upcoming', label: `Due in ${days} days`, order: 3 };
    return { key: 'later', label: `Due in ${days} days`, order: 4 };
  }

  function cleanText(value, max = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function normalizeRequirement(definition, supplied = {}) {
    const status = VALID_REQUIREMENT_STATES.has(supplied.status) ? supplied.status : 'missing';
    return {
      key: definition.key,
      label: definition.label,
      question: definition.question,
      status,
      note: cleanText(supplied.note, 240),
      confirmedAt: status === 'confirmed' ? cleanText(supplied.confirmedAt, 40) : '',
    };
  }

  function normalizeCase(input, options = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    const requirements = raw.requirements && typeof raw.requirements === 'object' ? raw.requirements : {};
    const dueDate = cleanText(raw.dueDate, 10);
    const days = daysUntil(dueDate, options.today);
    const consentStatus = VALID_CONSENT_STATES.has(raw.consent?.status) ? raw.consent.status : 'not_asked';
    const outreachStatus = VALID_OUTREACH_STATES.has(raw.outreach?.status) ? raw.outreach.status : 'not_started';
    const normalized = {
      id: cleanText(raw.id, 100),
      recordId: cleanText(raw.recordId, 120),
      displayName: cleanText(raw.displayName, 100) || 'Client',
      firstName: cleanText(raw.firstName, 60) || cleanText(raw.displayName, 100).split(' ')[0] || 'Client',
      programId: cleanText(raw.programId, 40),
      programName: cleanText(raw.programName, 80) || 'Benefits program',
      dueDate,
      preferredContact: cleanText(raw.preferredContact, 30) || 'Caseworker follow-up',
      requirements: REQUIREMENTS.map((definition) => normalizeRequirement(definition, requirements[definition.key])),
      consent: {
        status: consentStatus,
        recordedAt: cleanText(raw.consent?.recordedAt, 40),
        scope: consentStatus === 'authorized' ? 'prepare_through_review' : '',
      },
      outreach: {
        status: outreachStatus,
        completedAt: cleanText(raw.outreach?.completedAt, 40),
        channel: cleanText(raw.outreach?.channel, 30) || cleanText(raw.preferredContact, 30) || 'Caseworker follow-up',
      },
      source: cleanText(raw.source, 40) || 'connector',
      daysUntilDue: days,
      urgency: urgencyFor(days),
    };
    normalized.openRequirements = normalized.requirements.filter((item) => ['missing', 'stale'].includes(item.status));
    normalized.readyToPrepare = normalized.openRequirements.length === 0 && normalized.consent.status === 'authorized';
    return normalized;
  }

  function normalizeCaseload(items, options = {}) {
    return (Array.isArray(items) ? items : [])
      .map((item) => normalizeCase(item, options))
      .filter((item) => item.id && item.recordId && item.programId && dateOnly(item.dueDate))
      .sort((left, right) => left.urgency.order - right.urgency.order || left.dueDate.localeCompare(right.dueDate));
  }

  function summarize(items) {
    const cases = Array.isArray(items) ? items : [];
    return {
      total: cases.length,
      dueWithin45Days: cases.filter((item) => Number.isFinite(item.daysUntilDue) && item.daysUntilDue <= 45).length,
      needsData: cases.filter((item) => item.openRequirements.length > 0).length,
      awaitingAuthorization: cases.filter((item) => !item.openRequirements.length && item.consent.status !== 'authorized').length,
      ready: cases.filter((item) => item.readyToPrepare).length,
    };
  }

  function dueDateLabel(value, locale = 'en-US') {
    const date = dateOnly(value);
    return date ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date) : 'Date unavailable';
  }

  function notificationPlan(item) {
    const missingLabels = item.openRequirements.map((requirement) => requirement.label);
    const needed = missingLabels.length ? ` We still need: ${missingLabels.join(', ')}.` : '';
    const due = dueDateLabel(item.dueDate);
    return {
      caseworker: {
        title: `${item.programName} recertification ${item.urgency.label.toLowerCase()}`,
        body: `${item.displayName}'s ${item.programName} recertification is due ${due}.${needed}`,
      },
      client: {
        title: `Your ${item.programName} renewal is coming up`,
        body: `Hi ${item.firstName}, your ${item.programName} recertification is due ${due}.${needed} Would you like the AI assistant to prepare the application through the review page for you? You or your caseworker will review, certify, sign, and submit it.`,
      },
    };
  }

  function mergeWorkspace(item, saved = {}) {
    const requirements = Object.fromEntries(item.requirements.map((requirement) => {
      const override = saved.requirements?.[requirement.key];
      if (!override || !VALID_REQUIREMENT_STATES.has(override.status)) return [requirement.key, requirement];
      return [requirement.key, normalizeRequirement(requirement, override)];
    }));
    return normalizeCase({
      ...item,
      requirements,
      consent: saved.consent || item.consent,
      outreach: saved.outreach || item.outreach,
    });
  }

  const api = {
    REQUIREMENTS,
    daysUntil,
    urgencyFor,
    normalizeCase,
    normalizeCaseload,
    summarize,
    dueDateLabel,
    notificationPlan,
    mergeWorkspace,
  };

  root.NavaRecertificationEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
