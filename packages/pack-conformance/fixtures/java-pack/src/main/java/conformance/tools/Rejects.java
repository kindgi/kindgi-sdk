// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.ConnectionRejectedException;
import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class Rejects {
  public static final Tool<Map<String, Object>, Map<String, Object>> TOOL = Tool.define("conformance.rejects")
      .description("Says the app refused the connection mail, or wraps that refusal.")
      .set("needsSpec", Map.of(
          "connections", Map.of(
              "mail", Map.of("app", "google", "permissions", List.of("gmail.send"), "as", "person"))))
      .handler((input, ctx) -> {
        ConnectionRejectedException refused = new ConnectionRejectedException("mail", "refused");
        if (Boolean.TRUE.equals(input.get("wrapped"))) {
          throw new IllegalStateException("send failed", refused);
        }
        throw refused;
      });
}
