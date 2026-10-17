// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class Defaults {
  static final Map<String, Object> INPUT = Map.of(
      "type", "object",
      "properties", Map.of(
          "name", Map.of("type", "string"),
          "greeting", Map.of("type", "string", "default", "Hello"),
          "options", Map.of(
              "type", "object",
              "properties", Map.of("loud", Map.of("type", "boolean", "default", false)),
              "default", Map.of())),
      "required", List.of("name"));

  public static final Tool<Map<String, Object>, Object> TOOL = Tool.define("conformance.defaults")
      .description("Returns its input as the handler received it, defaults filled in.")
      .input(INPUT)
      .output(Map.of("type", "object"))
      .handler((input, ctx) -> input);
}
