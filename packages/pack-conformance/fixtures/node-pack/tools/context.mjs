// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

export default {
  id: 'conformance.context',
  description: 'Returns the call context it received.',
  version: '1.0.0',
  input: { type: 'object' },
  output: { type: 'object' },
  effects: [],
  handler: async (_input, ctx) => ({
    tenantId: ctx.tenantId,
    runId: ctx.runId,
    ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    ...(ctx.projectId !== undefined && { projectId: ctx.projectId }),
    ...(ctx.orgId !== undefined && { orgId: ctx.orgId }),
    env: ctx.env ?? {},
    secrets: ctx.secrets ?? {},
    config: ctx.config ?? {},
    ...(ctx.settings !== undefined && { settings: ctx.settings }),
  }),
};
