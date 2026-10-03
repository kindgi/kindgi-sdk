// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// Reviewer role vocabulary — the seniority ranks used by HITL approval
// flows to gate action review. Higher rank subsumes lower: a `senior`
// reviewer can act on anything requiring `standard`, and `admin` on
// anything requiring `standard` or `senior`.
//
// Role type + rank map live in the public authz vocabulary because
// reviewer roles are consumed by:
//   - HITL approval bindings
//   - API route validators and `ReviewerBinding` (@kindgi/api)
//   - Client response types (@kindgi/client)
//
// Concrete role assignment / storage is caller-plugged via the
// `ReviewerBinding` interface (declared in @kindgi/api).
//

export type ReviewerRole = 'standard' | 'senior' | 'admin';

/**
 * Rank order — index into an ordered scale so callers can express
 * "requires >= senior" without hard-coding string comparisons.
 * Higher number = more senior.
 */
export const REVIEWER_ROLE_RANK: Readonly<Record<ReviewerRole, number>> = {
  standard: 0,
  senior: 1,
  admin: 2,
};
