# Researcher Applications Module — Brainstorm

**Date:** 2026-04-11
**Goal:** Replace FCAT's Airtable-based external researcher application system with a
module inside the FCAT Portal, and retire Airtable entirely for this workflow.

## What We're Building

A new portal module, `/research-applications` (exposed as a project "Researcher
Applications" in the existing per-project permission model), that handles the full
lifecycle of an external researcher working at FCAT Reserve:

1. **Public application submission** — unauthenticated form for external researchers
   mirroring the fields in the current Airtable form (project title, PI/collaborator
   info, goals, methods, sample/genetic-resource details, facilities needs, permits,
   3 references, supporting document upload, code-of-conduct agreement).
2. **Internal review** — committee members with Editor role on the new project review
   submissions, leave comments, and set status (Pending → Under review →
   Accepted / Rejected / Needs revision). Luis (or any Editor) records the official
   decision.
3. **Final report submission** — a public form reached via a signed link emailed
   to the researcher as the due date approaches; uploads a PDF report tied back to
   the original application.
4. **Email automation via Resend** — submission receipt, new-application notification
   to committee, final report reminders to applicants, and a monthly digest to the
   committee listing upcoming/due/submitted reports and new applications.
5. **Historical import** — one-time migration of the ~200 existing applications and
   their report PDFs from the CSV/HTML export, re-hosting attachments before
   Airtable's signed URLs expire.

## Why This Approach

- **Public form, no account**: External applicants are one-off visitors. Requiring
  login adds friction and duplicates auth for a tiny audience. A public POST endpoint
  that bypasses oauth2-proxy (with CAPTCHA + rate limiting) is the lightest path.
- **Signed-link report access**: Simplest thing for the applicant — they click a link
  in the reminder email we're already sending them, land on a pre-filled report form,
  upload the PDF, done. No reference IDs to remember, no lookup flow, no account.
- **New project in existing permission model**: The portal already has Visor/Editor/Admin
  roles per project. Making "Researcher Applications" a project means committee members
  get Editor role via the existing `/admin` UI, and `requirePermission()` is reused
  exactly as in other modules. No new permission primitives.
- **Single editor decides**: Matches current practice (Luis updates the table).
  Comments give the committee a place to discuss async without building a voting system.
- **Google Drive for files**: Reuses the portal's existing service-account Drive client,
  keeps large PDFs out of SQLite, and gives the committee a familiar Drive UI to browse
  attachments directly if they prefer.
- **Full build in one pass**: User preference — cleaner cutover, one migration, no
  period of running both systems.

## Key Decisions

| Decision | Choice |
|---|---|
| Applicant access to submission form | Fully public (no login); CAPTCHA + rate limit |
| Applicant access to final report form | Signed link sent in reminder emails |
| Review workflow | Editor role on the project updates status; threaded comments for discussion |
| Permission model | New "Researcher Applications" project with Visor/Editor/Admin roles |
| Historical data | Full import of ~200 applications + reports; download & re-host PDFs before Airtable URLs expire |
| File storage | Google Drive via existing service account |
| Email provider | Resend (already wired up) |
| Emails sent | Submission receipt, new-app notification to committee, final report reminders, monthly committee digest |
| Build phasing | Full build in one pass, then cut over |

## Scope Outline (for the planning phase)

**Data model (sketch, not final):**
- `research_applications` — all fields from the current Airtable form + status, decision,
  reviewer, timestamps, Drive folder ID, final report due date.
- `research_application_comments` — threaded committee discussion per application.
- `research_reports` — final reports linked to an application (Drive file IDs, submitted
  at, notes).
- Signed-link tokens (could be HMAC over `{applicationId, purpose, exp}` — no DB table
  needed).

**Pages / routes:**
- `/apply` (public) — submission form.
- `/apply/report/<signed-token>` (public) — final report form, pre-filled.
- `/research-applications` — list/filter for committee (Editor+).
- `/research-applications/[id]` — detail view with fields, attachments, comments, status
  controls.
- Public POST endpoints must be allowlisted in oauth2-proxy / the portal proxy.

**Emails (Resend):**
- On submission: receipt to applicant (with reference #), notification to committee list.
- Scheduled: final report reminders at T-30 / T-0 / T+7 days relative to due date.
- Monthly digest: committee-only summary of applications received, reports due, reports
  submitted. Runs via the existing cron setup in the Docker container.

**Migration:**
- Script reads `Researcher Applications-Grid view.csv` + `Reports-Grid view.csv`,
  downloads every Airtable-hosted PDF to Drive, writes rows into the new tables with
  original timestamps preserved.

## Open Questions (to resolve during planning)

1. **Decision email to applicant** — user did not select this in the email triggers.
   Is the intent to send accept/reject emails manually, or was that an oversight?
   Recommend adding it; low cost and currently tracked in Airtable as
   "Decision sent to applicant?".
2. **Spam protection** — CAPTCHA provider? hCaptcha is free and privacy-friendly;
   Cloudflare Turnstile is another good option. Also need per-IP rate limiting on the
   submission endpoint.
3. **Committee email list** — is the "committee" everyone with Editor role on the
   project, or a separately managed email list? Simpler if it's derived from roles.
4. **File size limits & virus scanning** — what's the expected max PDF size, and do we
   need any scanning before accepting uploads from the public?
5. **Form field drift** — should the new form match the Airtable form 1:1, or is this
   a chance to prune / rewrite fields? (Quick review of the HTML export during planning.)
6. **Languages** — application form in English (current Airtable is English), but
   portal UI is Spanish. Keep the applicant form English, committee UI Spanish?
7. **Reference contact verification** — currently references are just free-text on the
   form. Do we want to email them automatically, or is that out of scope?
8. **Data retention / GDPR-ish concerns** — how long do we keep rejected applications
   and their attachments? Any obligations around applicant PII?

## Next Step

Run `/workflows:plan` to turn this into an implementation plan.
