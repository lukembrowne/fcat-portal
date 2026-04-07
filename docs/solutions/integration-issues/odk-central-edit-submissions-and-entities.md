---
title: "ODK Central API: Editing Submissions and Updating Entities"
date: 2026-04-01
category: integration-issues
module: odk
tags: [odk-central, api, submissions, entities, migration]
symptoms:
  - "400.19: This PUT endpoint expects a deprecatedID metadata tag"
  - "409.15: Current version of the Entity is '1' and you provided 'undefined'"
  - Need to bulk-update submission field values in ODK Central
  - Need to rename species or fix typos in existing ODK data
---

# ODK Central API: Editing Submissions and Updating Entities

## Problem

When bulk-updating existing ODK Central data (e.g., renaming a species across
hundreds of submissions and entities), the API has non-obvious requirements that
cause 400 and 409 errors if not handled correctly.

## Root Cause

### Submission Editing (error 400.19)

ODK Central submissions are versioned. You can't just PUT modified XML — you must:

1. **Generate a new `instanceID`** (a fresh UUID) for the edit version
2. **Add a `deprecatedID`** tag pointing to the current version's `instanceID`

Without `deprecatedID`, you get error 400.19.

### Entity Updating (error 409.15)

The PATCH endpoint for entities requires version tracking. Using `If-Match: *`
header does NOT work (unlike many REST APIs). Instead, append `?force=true` to
the URL to skip version checking.

## Solution

### Editing a Submission

```typescript
// 1. GET the current XML
const xml = await fetch(
  `${ODK_URL}/v1/projects/${projectId}/forms/${formId}/submissions/${instanceId}.xml`,
  { headers: authHeaders }
).then((r) => r.text());

// 2. Extract current instanceID
const match = xml.match(/<(?:orx:)?instanceID>(.*?)<\/(?:orx:)?instanceID>/);
const currentInstanceValue = match[1];

// 3. Make your field edits to the XML string
let edited = xml.replace(/<field>old<\/field>/g, "<field>new</field>");

// 4. Replace instanceID with a new UUID
const newId = `uuid:${crypto.randomUUID()}`;
edited = edited.replace(currentInstanceValue, newId);

// 5. Insert deprecatedID pointing to the old instanceID
// (after the closing instanceID tag)
const prefix = match[0].includes("orx:") ? "orx:" : "";
edited = edited.replace(
  /<\/(?:orx:)?instanceID>/,
  `</${prefix}instanceID><${prefix}deprecatedID>${currentInstanceValue}</${prefix}deprecatedID>`
);

// 6. PUT the modified XML
await fetch(
  `${ODK_URL}/v1/projects/${projectId}/forms/${formId}/submissions/${instanceId}`,
  { method: "PUT", headers: { ...authHeaders, "Content-Type": "application/xml" }, body: edited }
);
```

### Updating an Entity

```typescript
// Use ?force=true — NOT If-Match header
await fetch(
  `${ODK_URL}/v1/projects/${projectId}/datasets/${datasetName}/entities/${uuid}?force=true`,
  {
    method: "PATCH",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { field_name: "new value" } }),
  }
);
```

## Additional Gotchas

### ODK Collect trailing spaces in free-text fields

When users type values into free-text fields (e.g., `otra_especie` for "other"
species), ODK Collect often adds a trailing space. Always use `.trim()` when
matching OData values against expected strings:

```typescript
// BAD — won't match "Cedro Castillo Nueva Especie "
submissions.filter((s) => s.nombre_especie === "Cedro Castillo Nueva Especie");

// GOOD
submissions.filter(
  (s) => typeof s.nombre_especie === "string" &&
    s.nombre_especie.trim() === "Cedro Castillo Nueva Especie"
);
```

For XML replacement, use `\s*` around the expected value to catch trailing spaces.

### `server-only` blocks standalone scripts

`odk-client.ts` imports `"server-only"` which prevents `npx tsx` scripts from
using it. For one-time migration scripts, duplicate the auth/fetch logic directly
in the script rather than trying to import from `odk-client.ts`.

## Prevention

- When running bulk ODK data migrations, always implement a 3-mode script:
  `--dry-run` (default), `--test` (update 1 record), `--commit` (update all)
- Always trim string comparisons against OData values from free-text fields
- Reference: https://docs.getodk.org/central-api-submission-management/
- Reference: https://docs.getodk.org/central-api-entity-management/
