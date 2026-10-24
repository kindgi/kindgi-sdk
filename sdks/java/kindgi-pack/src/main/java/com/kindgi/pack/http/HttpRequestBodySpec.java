// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.http;

import java.util.Objects;

/** What the runtime sends as an HTTP tool's request body. */
public sealed interface HttpRequestBodySpec
    permits HttpRequestBodySpec.JsonInput,
        HttpRequestBodySpec.InputPassthrough,
        HttpRequestBodySpec.Text {

  /** The tool's input, serialized as a JSON request body. */
  record JsonInput() implements HttpRequestBodySpec {}

  /** The tool's input, passed through unchanged as the request body. */
  record InputPassthrough() implements HttpRequestBodySpec {}

  /** A text template; its {@code {placeholders}} are filled from the tool's input fields. */
  record Text(String template) implements HttpRequestBodySpec {
    public Text {
      Objects.requireNonNull(template, "template");
    }
  }
}
