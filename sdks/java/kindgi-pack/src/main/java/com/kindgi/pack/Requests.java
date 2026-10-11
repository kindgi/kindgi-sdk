// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.log.Logger;
import com.kindgi.pack.internal.Json;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** Pack protocol v2 requests: parsing, with the TypeScript and Python services' messages. */
final class Requests {
  private Requests() {}

  /**
   * A tool or check call.
   *
   * @param tool whether it calls a tool (else a check)
   * @param id the tool's or check's id
   * @param version the tool version the caller names; {@code null} when it names none
   * @param input the tool's input
   * @param ctx the tool call's context
   * @param config the check's config
   * @param trace the check's trace
   */
  record Call(
      boolean tool,
      String id,
      @Nullable String version,
      @Nullable Object input,
      Map<String, Object> ctx,
      Map<String, Object> config,
      @Nullable Object trace) {}

  /**
   * @param value a decoded request body
   * @return the {@link Call}, or the error message to answer with
   */
  @SuppressWarnings("unchecked")
  static Object parse(@Nullable Object value) {
    if (!(value instanceof Map)) {
      return PackService.error("malformed-message", "Message must be a JSON object", null);
    }
    Map<String, Object> message = (Map<String, Object>) value;
    Object v = message.get("v");
    // A number equal to 2 (2.0 too, as JavaScript and Python compare); never a boolean.
    if (!(v instanceof Number) || ((Number) v).doubleValue() != PackService.PROTOCOL) {
      return PackService.error("unknown-protocol-version",
          "Expected protocol v" + PackService.PROTOCOL + ", got " + Json.compactString(v), null);
    }
    Object kind = message.get("kind");
    if ("invoke".equals(kind)) {
      return toolInvoke(message);
    }
    if ("check-invoke".equals(kind)) {
      return checkInvoke(message);
    }
    return PackService.error("unexpected-message-kind", "Unknown request kind " + Json.compactString(kind), null);
  }

  @SuppressWarnings("unchecked")
  private static Object toolInvoke(Map<String, Object> message) {
    Object tool = message.get("tool");
    if (!(tool instanceof Map)) {
      return PackService.error("malformed-message", "`tool.id` is required", null);
    }
    Map<String, Object> ref = (Map<String, Object>) tool;
    Object id = ref.get("id");
    if (!(id instanceof String) || ((String) id).isEmpty()) {
      return PackService.error("malformed-message", "`tool.id` is required", null);
    }
    Object version = ref.get("version");
    if (version != null && !(version instanceof String)) {
      return PackService.error("malformed-message", "`tool.version` must be a string", null);
    }
    Object ctx = message.get("ctx");
    if (!(ctx instanceof Map)
        || !(((Map<String, Object>) ctx).get("tenantId") instanceof String)
        || !(((Map<String, Object>) ctx).get("runId") instanceof String)) {
      return PackService.error("malformed-message", "`ctx` needs string `tenantId` and `runId`", null);
    }
    return new Call(true, (String) id, (String) version, message.get("input"), (Map<String, Object>) ctx, Map.of(), null);
  }

  @SuppressWarnings("unchecked")
  private static Object checkInvoke(Map<String, Object> message) {
    Object check = message.get("check");
    Object id = check instanceof Map ? ((Map<String, Object>) check).get("id") : null;
    if (!(id instanceof String) || ((String) id).isEmpty()) {
      return PackService.error("malformed-message", "`check.id` is required", null);
    }
    Object config = message.get("config");
    if (!(config instanceof Map)) {
      return PackService.error("malformed-message", "`config` must be an object", null);
    }
    return new Call(false, (String) id, null, null, Map.of(), (Map<String, Object>) config, message.get("trace"));
  }

  /**
   * The context for a v2 {@code ctx}: maps where it sends them, empty ones where it doesn't, and the
   * call's logger.
   */
  @SuppressWarnings("unchecked")
  static ToolContext context(Map<String, Object> ctx, Cancellation cancellation, Logger log) {
    Map<String, Map<String, Object>> settings = new LinkedHashMap<>();
    if (ctx.get("settings") instanceof Map) {
      ((Map<String, Object>) ctx.get("settings")).forEach((block, values) -> {
        if (values instanceof Map) {
          settings.put(block, (Map<String, Object>) values);
        }
      });
    }
    return new ToolContext(
        (String) ctx.get("tenantId"),
        (String) ctx.get("runId"),
        text(ctx, "requestId"),
        text(ctx, "projectId"),
        text(ctx, "orgId"),
        map(ctx, "env"),
        map(ctx, "secrets"),
        map(ctx, "config"),
        settings,
        cancellation,
        log,
        text(ctx, "idempotencyKey"));
  }

  private static @Nullable String text(Map<String, Object> ctx, String key) {
    Object v = ctx.get(key);
    return v instanceof String ? (String) v : null;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Map<String, Object> ctx, String key) {
    Object v = ctx.get(key);
    return v instanceof Map ? (Map<String, Object>) v : Map.of();
  }
}
