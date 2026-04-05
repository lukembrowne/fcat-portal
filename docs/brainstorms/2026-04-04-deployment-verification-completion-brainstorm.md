# Deployment Verification & Completion Tracking

**Date**: 2026-04-04
**Status**: Ready for planning

## What We're Building

A verification progress tracking system for camera trap deployments so researchers know when a deployment is fully reviewed and "done." Currently, deployments with detections stay in `processed` status indefinitely — there's no way to know which ones still need review, how much review is left, or when it's safe to export data.

### The Problem

- Deployments with detections never move to `verified` — they stay `processed` forever
- No visibility into how many identifications have been reviewed vs. pending
- The overview stats (`porRevisar` vs `verificadas`) are inaccurate for deployments with detections
- Researchers can't tell which deployments need attention or are ready for export

### The Solution

Build on existing per-identification verification statuses to derive deployment-level progress, with both automatic and manual completion paths.

## Why This Approach

Uses what already exists (per-ID `verificationStatus` field) rather than adding a new tracking layer. The auto-transition removes busywork for the common case, while manual sign-off handles "good enough" scenarios. Keeps schema changes minimal — just add `verifiedBy`/`verifiedAt` if needed later.

Rejected alternative: A separate `deploymentVerification` table with explicit sign-off, reviewer tracking, and QA notes. Deemed overkill for current needs (YAGNI).

## Key Decisions

1. **Dual completion paths**: Auto-transition to `verified` when all IDs are reviewed (verified/rejected/corrected, none `unverified`) AND manual "Marcar como verificada" button for early sign-off.

2. **Progress visible in two places**: Verification progress counter (`23/45 identificaciones verificadas`) shown on both the deployments table and the deployment detail page.

3. **Reversible**: Re-running ML on a verified deployment auto-reverts to `processed`. Manual "Re-abrir revisión" button also available.

4. **Progress derived, not stored**: Count verified/total IDs on the fly from existing data — no new columns needed for tracking progress. (May need to optimize with a materialized count if performance is an issue.)

## Scope

### In Scope
- Verification progress counter on deployments table (column or badge annotation)
- Verification progress counter/bar on deployment detail page
- Auto-transition: deployment → `verified` when all IDs reviewed
- Manual "Marcar como verificada" button on deployment detail page
- Manual "Re-abrir revisión" button on verified deployments
- Auto-revert to `processed` when new ML job is run on a verified deployment
- Update overview stats to accurately reflect verified deployments

### Out of Scope (for now)
- Audit trail (who verified, when) — can add `verifiedBy`/`verifiedAt` later
- QA notes on verification sign-off
- Batch verification across multiple deployments
- Export workflow triggered by verification completion

## Open Questions

- Should the auto-transition happen synchronously on the last verification action, or via a background check? (Synchronous is simpler but adds latency to the last verify click.)
- What counts as "reviewed" — only `verified`, or also `rejected` and `corrected`? (Likely all three — anything that's not `unverified`.)
- Performance: will counting unverified IDs per deployment be fast enough for the table view, or do we need a cached count?
