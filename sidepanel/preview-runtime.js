// Simulated preview runtime: answers service-worker and page-agent messages with fictional data when the panel runs without extension APIs, and loads the ?queue= and ?fixture= preview states.
(function installPreviewRuntime(root) {
  'use strict';

  const FICTIONAL_ORGANIZATION = 'Nava fictional test data';
  const PREVIEW_RECORD_ID = '339619';

  const PREVIEW_DOCUMENTS = {
    pdf: { name: 'sample-client.pdf', type: 'application/pdf' },
    docx: { name: 'sample-business.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    csv: { name: 'sample-business.csv', type: 'text/csv' },
    ocr: { name: 'sample-client-scan.png', type: 'image/png' },
    ocrpdf: { name: 'sample-client-scan.pdf', type: 'application/pdf' },
  };

  /** The three-page simulated application, built fresh for every message so no response shares mutable state. */
  function previewPages() {
    return {
      1: {
        title: 'About the applicant',
        fields: [
          { fieldKey: 'page1:first', type: 'text', label: 'First Name', required: true, autocomplete: 'given-name', value: '' },
          { fieldKey: 'page1:middle', type: 'text', label: 'Middle Name', autocomplete: 'additional-name', value: '' },
          { fieldKey: 'page1:last', type: 'text', label: 'Last Name', required: true, autocomplete: 'family-name', value: '' },
          { fieldKey: 'page1:dob', type: 'text', label: 'Date of Birth', required: true, id: 'birthDate', maxLength: 10, value: '' },
        ],
        gate: { kind: 'next', text: 'Next', pageSignature: 'preview:page-1', reason: 'A known safe “Next” control is ready.' },
      },
      2: {
        title: 'Home address',
        fields: [
          { fieldKey: 'page2:street', type: 'text', label: 'Street address', required: true, autocomplete: 'address-line1', value: '' },
          { fieldKey: 'page2:unit', type: 'text', label: 'Apartment or unit', autocomplete: 'address-line2', value: '' },
          { fieldKey: 'page2:city', type: 'text', label: 'City', required: true, autocomplete: 'address-level2', value: '' },
          { fieldKey: 'page2:state', type: 'text', label: 'State', required: true, autocomplete: 'address-level1', value: '' },
          { fieldKey: 'page2:zip', type: 'text', label: 'ZIP code', required: true, autocomplete: 'postal-code', maxLength: 5, value: '' },
        ],
        gate: { kind: 'next', text: 'Save and continue', pageSignature: 'preview:page-2', reason: 'A known safe “Save and continue” control is ready.' },
      },
      3: {
        title: 'Contact and final review',
        fields: [
          { fieldKey: 'page3:email', type: 'email', label: 'Email', required: true, autocomplete: 'email', value: '' },
          { fieldKey: 'page3:phone', type: 'tel', label: 'Mobile Phone', required: true, autocomplete: 'tel', maxLength: 10, value: '' },
          { fieldKey: 'page3:language', type: 'text', label: 'Primary language', autocomplete: 'language', value: '' },
        ],
        gate: { kind: 'final_review', text: 'Submit application', pageSignature: 'preview:page-3', reason: 'The application reached its final review step. Submission stays with the caseworker.' },
      },
    };
  }

  function demoConnector() {
    return { mode: 'demo', provider: 'bundled-demo-records', organizationName: FICTIONAL_ORGANIZATION, status: 'ready' };
  }

  /**
   * deps:
   * - state, previewMode, demoMode, search: panel state, preview flags, and the panel URL's query string.
   * - engine, connectorEngine, programCatalog, workQueueEngine: the shared engines.
   * - DEMO_RECORDS, PREVIEW_CONNECTOR_SCHEMA, PREVIEW_RAW_RECORD: fictional records declared in sidepanel.js.
   * - managedConnector(), checkpoint(kind, label), assertUiGeneration(token): panel and policy helpers.
   * - parseDocument(file): the on-device document parser.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      demoMode,
      search,
      engine,
      connectorEngine,
      programCatalog,
      workQueueEngine,
      DEMO_RECORDS,
      PREVIEW_CONNECTOR_SCHEMA,
      PREVIEW_RAW_RECORD,
      managedConnector,
      checkpoint,
      assertUiGeneration,
      parseDocument,
    } = deps;

    /** Answers a service-worker message with fictional data; one responder per message type. */
    function previewRuntime(message) {
      if (message.type === 'GET_CONNECTOR_STATUS') return Promise.resolve(connectorStatus());
      if (message.type === 'DISCOVER_CONNECTOR') return Promise.resolve(discoverConnector(message));
      if (message.type === 'SAVE_CONNECTOR') return Promise.resolve(saveConnector(message));
      if (message.type === 'RESET_CONNECTOR') return Promise.resolve(resetConnector());
      if (message.type === 'LOOKUP_RECORD') return Promise.resolve(lookupRecord(message));
      if (message.type === 'LIST_RECERTIFICATIONS') return Promise.resolve(listRecertifications());
      if (message.type === 'OPEN_PROGRAMS') return Promise.resolve(openPrograms(message));
      return Promise.resolve({ ok: true });
    }

    function connectorStatus() {
      return { ok: true, connector: state.connector || demoConnector() };
    }

    function discoverConnector(message) {
      try {
        const config = connectorEngine.sanitizeConfig(message.config);
        if (config.provider !== 'apricot360') {
          return { ok: false, error: 'This simulated preview includes only the fictional Apricot-shaped adapter. Use a provisioned Nava connector service for this provider.' };
        }
        const schema = connectorEngine.normalizeSchemaFields(PREVIEW_CONNECTOR_SCHEMA);
        return {
          ok: true,
          health: { organizationName: config.organizationName, provider: config.provider },
          config,
          schema,
          suggestions: connectorEngine.suggestMappings(schema, config.mappings),
        };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }

    function saveConnector(message) {
      try {
        const config = connectorEngine.validateMappings(message.config, message.schema);
        state.connector = { ...config, status: 'ready', connectedAt: new Date().toISOString(), schemaFieldCount: message.schema.length };
        return { ok: true, connector: state.connector };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }

    function resetConnector() {
      state.connector = demoConnector();
      return { ok: true, connector: state.connector };
    }

    function lookupRecord(message) {
      if (managedConnector()) return lookupConnectorRecord(message);
      const record = DEMO_RECORDS[String(message.recordId)] || null;
      return {
        ok: Boolean(record),
        record,
        message: record ? 'Demo record loaded.' : 'Preview mode only includes demo ID 339619.',
      };
    }

    function lookupConnectorRecord(message) {
      if (String(message.recordId) !== PREVIEW_RECORD_ID) return { ok: false, record: null, message: 'The preview connector includes record 339619.' };
      try {
        const mapped = connectorEngine.mapRecord(PREVIEW_RAW_RECORD, state.connector, PREVIEW_CONNECTOR_SCHEMA);
        return {
          ok: mapped.found,
          record: mapped.record,
          provider: state.connector.provider,
          connector: { organizationName: state.connector.organizationName, stale: mapped.stale, mappedFields: Object.keys(mapped.provenance).length },
          message: 'Record loaded from the preview connector.',
        };
      } catch (error) {
        return { ok: false, record: null, error: error.message };
      }
    }

    function listRecertifications() {
      const now = new Date();
      const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 12)).toISOString().slice(0, 10);
      return {
        ok: true,
        source: 'fictional-demo',
        connector: { organizationName: FICTIONAL_ORGANIZATION },
        cases: [{
          id: 'preview-recert-339619-calfresh', recordId: '339619', displayName: 'Celeste Thomas II', firstName: 'Celeste',
          programId: 'calfresh', programName: 'CalFresh', dueDate: due, preferredContact: 'Email',
          requirements: {
            contact: { status: 'current' }, household: { status: 'missing' }, income: { status: 'stale' },
            expenses: { status: 'missing' }, documents: { status: 'missing' },
          },
          source: 'fictional-demo',
        }],
      };
    }

    function openPrograms(message) {
      return {
        ok: true,
        opened: programCatalog.planWorkflows(message.programs).map((workflow, index) => ({
          ...workflow,
          tabId: 8000 + index,
        })),
      };
    }

    /** A page-agent reply, delayed in ?demo=1 so the simulated fill and advance can be watched. */
    function previewResponse(payload, delay = 0) {
      return demoMode && delay
        ? new Promise((resolve) => setTimeout(() => resolve(payload), delay))
        : Promise.resolve(payload);
    }

    /** Answers a page-agent command against the simulated page; one responder per message type. It never submits. */
    function previewTabMessage(message) {
      const pages = previewPages();
      const page = pages[state.previewPage] || pages[3];
      if (message.type === 'NAVA_SCAN') return previewResponse(scanPage(page, message), 240);
      if (message.type === 'NAVA_FILL') return previewResponse(fillPage(page, message), 650);
      if (message.type === 'NAVA_NAVIGATION_STATUS') return previewResponse({ ok: true, navigationGate: page.gate }, 180);
      if (message.type === 'NAVA_ADVANCE') return advancePage(page);
      return previewResponse({ ok: true });
    }

    function scanPage(page, message) {
      return {
        ok: true,
        page: { title: page.title, url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}`, domain: 'benefitscal.com' },
        playbook: { status: 'fresh', name: 'California benefits application', note: 'Bundled BenefitsCal playbook; automatic continuation is limited to exact Begin, Next, and Continue controls.' },
        analysis: engine.buildAnalysis(page.fields, message.participant),
        submitGate: { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
        navigationGate: page.gate,
      };
    }

    function fillPage(page, message) {
      const results = message.assignments.map((item) => ({ ...item, status: 'verified', actual: item.value, reason: '' }));
      return {
        ok: true,
        results,
        provenance: results.map((item) => ({ ...item, value: item.sensitive ? '••••' : item.actual })),
        submitGate: state.previewPage === 3
          ? { found: true, enabled: true, botCheckPresent: false, blockedReason: 'The assistant never activates Submit application.' }
          : { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
        navigationGate: page.gate,
      };
    }

    function advancePage(page) {
      if (page.gate.kind !== 'next') return previewResponse({ ok: true, advanced: false, navigationGate: page.gate });
      state.previewPage = Math.min(3, state.previewPage + 1);
      return previewResponse({ ok: true, advanced: true, navigationGate: page.gate }, 900);
    }

    /** ?queue=paused or ?queue=expired: a paused (or source-expired) BenefitsCal run beside a pending WIC handoff. */
    function loadPreviewQueueFixture() {
      if (!previewMode) return false;
      const fixture = new URLSearchParams(search).get('queue');
      if (!fixture) return false;
      const expired = fixture === 'expired';
      const capturedAt = new Date().toISOString();
      state.previewPage = 2;
      const paused = {
        id: 'workflow:preview-benefits',
        tabId: 7001,
        name: 'California benefits application',
        queueLabel: 'California benefits application',
        url: 'https://benefitscal.com/ApplyForBenefits/step-2',
        status: expired ? 'source_expired' : 'paused',
        completedPages: [{ title: 'About the applicant', provenance: [], completedAt: capturedAt }],
        checkpoint: expired ? checkpoint('source_expired', 'Reload client data') : checkpoint('voluntary_pause', 'Paused by caseworker'),
        resumePoint: {
          location: 'https://benefitscal.com/ApplyForBenefits/step-2',
          pageSignatureHash: workQueueEngine.signatureHash('preview:page-2'),
          capturedAt,
        },
        updatedAt: capturedAt,
      };
      state.apps = [paused, previewHandoff(capturedAt)];
      state.participant = expired ? null : DEMO_RECORDS[PREVIEW_RECORD_ID];
      state.audit = [workQueueEngine.auditEvent('checkpoint_reached', paused, {
        checkpointKind: paused.checkpoint.kind,
        toStatus: paused.status,
      }, { at: capturedAt, id: 'preview-event' })];
      state.view = 'dashboard';
      return true;
    }

    function previewHandoff(capturedAt) {
      return {
        id: 'workflow:preview-wic',
        tabId: 8001,
        name: 'WIC',
        queueLabel: 'WIC',
        url: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
        status: 'handoff_pending',
        completedPages: [],
        checkpoint: checkpoint('handoff', 'Assigned handoff awaiting acceptance'),
        owner: { assignedTo: 'Intake team', state: 'pending', assignedAt: capturedAt },
        handoff: { to: 'Intake team', reason: 'client_question', createdAt: capturedAt, acceptedAt: null },
        resumePoint: {
          location: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
          pageSignatureHash: '',
          capturedAt,
        },
        updatedAt: capturedAt,
      };
    }

    /** ?fixture=<key>: parses a bundled sample document and opens its review screen (?conflict=1 also loads the demo client). */
    async function loadPreviewDocumentFixture(uiToken) {
      if (!previewMode) return false;
      const params = new URLSearchParams(search);
      const fixture = PREVIEW_DOCUMENTS[params.get('fixture')];
      if (!fixture) return false;
      const response = await fetch(`../demo/fixtures/${fixture.name}`);
      if (!response.ok) throw new Error('The local preview document could not be loaded.');
      const file = new File([await response.arrayBuffer()], fixture.name, { type: fixture.type });
      const documentResult = await parseDocument(file);
      assertUiGeneration(uiToken);
      state.documentResult = documentResult;
      if (params.get('conflict') === '1') state.participant = DEMO_RECORDS[PREVIEW_RECORD_ID];
      state.view = 'document-review';
      return true;
    }

    return { previewRuntime, previewTabMessage, loadPreviewQueueFixture, loadPreviewDocumentFixture };
  }

  const api = { create };

  root.NavaPreviewRuntime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
