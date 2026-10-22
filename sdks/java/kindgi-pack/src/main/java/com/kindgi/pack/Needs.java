// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.SchemaValidator;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * A tool's {@code needsSpec}: the typed context a tool declares it needs — {@code env} and
 * {@code secrets} values by name (each a JSON Schema), {@code config}, {@code capabilities} and
 * {@code bindings}. This class holds the two checks the SDK makes on it, matching the TypeScript
 * {@code @kindgi/tools}: the definition-time check the indexer runs ({@link #check}) and the
 * test-context fill the {@link ToolContext#forTest(Tool, Map, Map) test helper} runs
 * ({@link #resolveEnv}).
 *
 * <p>Only {@code env} and {@code secrets} have schemas to check; {@code config},
 * {@code capabilities} and {@code bindings} are carried, not validated here. The pack-index schema
 * already checks the shape of {@code needsSpec} itself (that each slot's value is an object); these
 * checks go deeper — that each schema compiles, and that an {@code env} default is a string.
 */
final class Needs {
  private Needs() {}

  /**
   * The problem with a tool's {@code needsSpec}, at definition time, as the indexer reports it: a
   * schema under {@code env} or {@code secrets} that doesn't compile, or an {@code env} default
   * that isn't a string. Mirrors the TypeScript {@code needsSpecProblem}: the slots are checked in
   * the order {@code secrets} then {@code env}, their entries in order, and the first problem wins.
   *
   * @param toolId the tool's id
   * @param needsSpec the tool's {@code needsSpec} value, as indexed; anything but a map is left to
   *     the pack-index schema
   * @return the problem, phrased as the indexer's other entry problems are; {@code null} when there
   *     is none
   */
  static @Nullable String check(String toolId, @Nullable Object needsSpec) {
    if (!(needsSpec instanceof Map)) {
      return null;
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> spec = (Map<String, Object>) needsSpec;
    for (String slot : new String[] {"secrets", "env"}) {
      if (!(spec.get(slot) instanceof Map)) {
        continue;
      }
      @SuppressWarnings("unchecked")
      Map<String, Object> declared = (Map<String, Object>) spec.get(slot);
      for (Map.Entry<String, Object> e : declared.entrySet()) {
        String name = e.getKey();
        if (!(e.getValue() instanceof Map)) {
          continue;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> schema = (Map<String, Object>) e.getValue();
        try {
          new SchemaValidator(schema);
        } catch (SchemaValidator.SchemaException compile) {
          return invalid(toolId, "/needsSpec/" + slot + "/" + name,
              "the schema doesn't compile: " + compile.getMessage());
        }
        if (slot.equals("env")) {
          Object fallback = schema.get("default");
          if (fallback != null && !(fallback instanceof String)) {
            return invalid(toolId, "/needsSpec/env/" + name + "/default",
                "the default must be a string: env values are strings");
          }
        }
      }
    }
    return null;
  }

  /**
   * The {@code env} a test should pass a handler: every name the tool declares under
   * {@code needsSpec.env}, taken from {@code given} or the schema's string default, each checked
   * against its schema. Mirrors the TypeScript {@code envForCall}: names the tool doesn't declare
   * are dropped, a missing value (no given value and no string default) fails before any check, and
   * the values are checked in declared order.
   *
   * @param toolId the tool's id, for the message
   * @param needsSpec the tool's {@code needsSpec} value
   * @param given the env a test offers, by name; {@code null} for none
   * @return the resolved env, by declared name
   * @throws IllegalStateException when a declared value is missing, doesn't match its schema, or is
   *     declared with a schema that doesn't compile
   */
  static Map<String, Object> resolveEnv(
      String toolId, @Nullable Object needsSpec, @Nullable Map<String, String> given) {
    Map<String, Object> declared = envSlot(needsSpec);
    Map<String, Object> resolved = new LinkedHashMap<>();
    if (declared.isEmpty()) {
      return resolved;
    }
    List<String> missing = new ArrayList<>();
    for (String name : declared.keySet()) {
      String value = given != null && given.containsKey(name) ? given.get(name) : stringDefault(declared.get(name));
      if (value == null) {
        missing.add(name);
      } else {
        resolved.put(name, value);
      }
    }
    if (!missing.isEmpty()) {
      throw new IllegalStateException(missingMessage(toolId, missing));
    }
    for (Map.Entry<String, Object> entry : resolved.entrySet()) {
      String name = entry.getKey();
      if (!(declared.get(name) instanceof Map)) {
        continue;
      }
      @SuppressWarnings("unchecked")
      Map<String, Object> schema = (Map<String, Object>) declared.get(name);
      SchemaValidator validator;
      try {
        validator = new SchemaValidator(schema);
      } catch (SchemaValidator.SchemaException compile) {
        throw new IllegalStateException("tool \"" + toolId + "\" declares env value \"" + name
            + "\" with a schema that doesn't compile: " + compile.getMessage());
      }
      List<Map<String, Object>> issues = validator.issues(entry.getValue());
      if (!issues.isEmpty()) {
        throw new IllegalStateException("env value \"" + name + "\" is \"" + entry.getValue()
            + "\", which doesn't match the schema tool \"" + toolId + "\" declares for it: "
            + constraintsBroken(issues));
      }
    }
    return resolved;
  }

  private static Map<String, Object> envSlot(@Nullable Object needsSpec) {
    if (needsSpec instanceof Map && ((Map<?, ?>) needsSpec).get("env") instanceof Map) {
      @SuppressWarnings("unchecked")
      Map<String, Object> env = (Map<String, Object>) ((Map<?, ?>) needsSpec).get("env");
      return env;
    }
    return Map.of();
  }

  private static @Nullable String stringDefault(@Nullable Object schema) {
    if (schema instanceof Map) {
      Object fallback = ((Map<?, ?>) schema).get("default");
      if (fallback instanceof String) {
        return (String) fallback;
      }
    }
    return null;
  }

  private static String missingMessage(String toolId, List<String> missing) {
    boolean one = missing.size() == 1;
    StringBuilder which = new StringBuilder(one ? "env value " : "env values ");
    for (int i = 0; i < missing.size(); i++) {
      which.append(i == 0 ? "" : ", ").append('"').append(missing.get(i)).append('"');
    }
    return "tool \"" + toolId + "\" needs " + which + ": the context's `env` doesn't set "
        + (one ? "it" : "them") + ", and " + (one ? "its schema has" : "their schemas have")
        + " no default";
  }

  private static String constraintsBroken(List<Map<String, Object>> issues) {
    StringBuilder out = new StringBuilder();
    for (Map<String, Object> issue : issues) {
      Object message = issue.get("message");
      if (message != null) {
        out.append(out.length() == 0 ? "" : "; ").append(message);
      }
    }
    return out.length() == 0 ? "it does not validate" : out.toString();
  }

  private static String invalid(String toolId, String at, String detail) {
    return "tool '" + toolId + "' is invalid at " + at + ": " + detail;
  }
}
