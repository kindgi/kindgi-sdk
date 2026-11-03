// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.testpacks.httptool.tools;

import com.kindgi.pack.Tool;
import com.kindgi.pack.http.HttpAuthSpec;
import com.kindgi.pack.http.HttpMethod;
import com.kindgi.pack.http.HttpToolSpec;
import com.kindgi.pack.http.ToolSecretRef;

/** A declarative HTTP tool: no handler — the Kindgi runtime makes the request from the spec. */
public final class Lookup {
  public record Input(String court, String docket) {}

  public record Output(String title) {}

  public static final Tool<Input, Output> TOOL =
      Tool.define("acme.lookup")
          .description("Look up a case in a court's public docket API.")
          .version("1.0.0")
          .mutating(false)
          .input(Input.class)
          .output(Output.class)
          .http(
              HttpToolSpec.builder()
                  .method(HttpMethod.GET)
                  .urlTemplate("https://cases.example.com/{court}/{docket}")
                  .header("accept", "application/json")
                  .authorization(new HttpAuthSpec.Bearer(new ToolSecretRef("production", "ACME_TOKEN")))
                  .successStatus(200, 299)
                  .build());

  private Lookup() {}
}
