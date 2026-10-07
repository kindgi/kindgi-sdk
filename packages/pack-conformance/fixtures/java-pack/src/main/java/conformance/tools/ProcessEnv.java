// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import java.util.Map;

public final class ProcessEnv {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("conformance.process-env")
      .description("Returns the names of the KINDGI_ variables in its process environment.")
      .handler((input, ctx) -> Map.of("names", System.getenv().keySet().stream()
          .filter(name -> name.startsWith("KINDGI_"))
          .sorted()
          .toList()));
}
