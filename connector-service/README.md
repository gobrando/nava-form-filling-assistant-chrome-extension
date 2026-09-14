# Connector service contract

The extension never connects directly to Apricot and never accepts an Apricot secret. It talks to a Nava-controlled, organization-authenticated service using an opaque connection ID.

Required read-only endpoints:

```text
GET /v1/connectors/{connectionId}/health
GET /v1/connectors/{connectionId}/schema?formId={formId}
GET /v1/connectors/{connectionId}/records/{recordId}?formId={formId}
```

The service must:

- authenticate the signed-in organization and authorize access to the requested connection;
- keep provider credentials in a server-side secret manager;
- apply least-privilege, read-only provider scopes;
- return CORS headers for the managed extension ID and allow credentialed requests;
- return labeled schema fields before any record is mapped;
- never log participant values, tokens, or raw record bodies;
- provide audit events containing organization, user, connection, record ID, outcome, and timestamp—but no participant values;
- rate-limit lookups and return generic errors to the extension; and
- expose revocation and credential-rotation controls to organization administrators.

`mock-server.mjs` is a loopback-only implementation containing fictional record `339619`. It exists solely to exercise the extension contract and does not accept provider credentials.

Run it with:

```bash
npm run connector:mock
```

Then configure the extension with:

```text
Organization: Riverside Community Services
Service URL: http://127.0.0.1:4789
Connection ID: nava-demo
Apricot form ID: 99
```

The archived application used a Sidekick-hosted Apricot API proxy and server-side OAuth client credentials. A production implementation can reuse that service pattern, subject to current Bonterra/partner access, security review, organization authorization, and an explicit data-processing agreement.
