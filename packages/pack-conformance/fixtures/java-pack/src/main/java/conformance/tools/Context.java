// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.ToolConnection;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Context {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("conformance.context")
      .description("Returns the call context it received.")
      .handler((input, ctx) -> {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tenantId", ctx.tenantId());
        out.put("runId", ctx.runId());
        out.put("env", ctx.env());
        out.put("secrets", ctx.secrets());
        out.put("config", ctx.config());
        if (ctx.requestId() != null) {
          out.put("requestId", ctx.requestId());
        }
        if (ctx.idempotencyKey() != null) {
          out.put("idempotencyKey", ctx.idempotencyKey());
        }
        if (ctx.projectId() != null) {
          out.put("projectId", ctx.projectId());
        }
        if (ctx.orgId() != null) {
          out.put("orgId", ctx.orgId());
        }
        if (!ctx.settings().isEmpty()) {
          out.put("settings", ctx.settings());
        }
        if (!ctx.connections().isEmpty()) {
          Map<String, Object> connections = new LinkedHashMap<>();
          ctx.connections().forEach((name, c) -> connections.put(name, connection(c)));
          out.put("connections", connections);
        }
        return out;
      });

  private static Map<String, Object> connection(ToolConnection c) {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("connectionId", c.connectionId());
    out.put("app", c.app());
    out.put("appName", c.appName());
    out.put("accessToken", c.accessToken());
    out.put("account", Map.of("id", c.account().id(), "label", c.account().label()));
    if (c.expiresAt() != null) {
      out.put("expiresAt", c.expiresAt());
    }
    return out;
  }
}
