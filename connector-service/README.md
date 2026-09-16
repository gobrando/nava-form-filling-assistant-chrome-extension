# Connector service contract

The extension never connects directly to a provider and never accepts provider secrets. It talks to a Nava-controlled, organization-authenticated service using an opaque connection ID. Provider selection and source identifiers are metadata; OAuth grants, API keys, refresh tokens, and vendor sessions remain server-side.

Required read-only endpoints:

```text
GET /v1/connectors/{connectionId}/health
GET /v1/connectors/{connectionId}/schema?sourceId={sourceId}
GET /v1/connectors/{connectionId}/records/{recordId}?sourceId={sourceId}
```

For backward compatibility, the fictional Apricot adapter also accepts `formId`. Production adapters may translate the opaque `sourceId` into a provider object, form, dataset, TouchPoint, or resource key.

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
Provider: Bonterra Apricot 360
Form / resource key: 99
```

The archived application used a Sidekick-hosted Apricot API proxy and server-side OAuth client credentials. A production Apricot adapter can reuse that service pattern, subject to current Bonterra/partner access, security review, organization authorization, and an explicit data-processing agreement. Other catalog providers require their own authorized adapters; see [`../docs/CONNECTOR_COVERAGE.md`](../docs/CONNECTOR_COVERAGE.md).
