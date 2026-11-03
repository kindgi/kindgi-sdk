// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.http.HttpAuthSpec;
import com.kindgi.pack.http.HttpMethod;
import com.kindgi.pack.http.HttpToolSpec;
import com.kindgi.pack.http.ToolSecretRef;

/** A declarative HTTP tool: no handler — the Kindgi runtime makes the request from the spec. */
public final class Http {
  public record Input(String path) {}

  public record Output(String url) {}

  public static final Tool<Input, Output> TOOL = Tool.define("conformance.http")
      .description("Reads a path from the example API.")
      .input(Input.class)
      .output(Output.class)
      .http(HttpToolSpec.builder()
          .method(HttpMethod.GET)
          .urlTemplate("https://api.example.com/{path}")
          .header("Accept", "application/json")
          .authorization(new HttpAuthSpec.Bearer(new ToolSecretRef("local", "API_TOKEN")))
          .successStatus(200, 299)
          .build());

  private Http() {}
}
