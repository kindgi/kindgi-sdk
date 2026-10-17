// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** A {@code multipart/form-data} body: text fields and files. */
public final class Multipart {
  private record Part(String name, byte[] data, @Nullable String filename) {}

  private final List<Part> parts = new ArrayList<>();

  /** An empty body. */
  public Multipart() {}

  /**
   * A text field, left out when {@code null}.
   *
   * @param name the field
   * @param value its value (written as text)
   * @return this
   */
  public Multipart text(String name, @Nullable Object value) {
    if (value != null) {
      parts.add(new Part(name, Wire.text(value).getBytes(StandardCharsets.UTF_8), null));
    }
    return this;
  }

  /**
   * A file, left out when {@code null}.
   *
   * @param name the field
   * @param data its bytes
   * @return this
   */
  public Multipart file(String name, byte @Nullable [] data) {
    if (data != null) {
      parts.add(new Part(name, data, name));
    }
    return this;
  }

  byte[] encode(String boundary) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (Part p : parts) {
      StringBuilder head = new StringBuilder("--").append(boundary).append("\r\n");
      head.append("Content-Disposition: form-data; name=\"").append(escape(p.name())).append('"');
      if (p.filename() != null) {
        head.append("; filename=\"").append(escape(p.filename())).append('"');
        head.append("\r\nContent-Type: application/octet-stream");
      }
      head.append("\r\n\r\n");
      out.writeBytes(head.toString().getBytes(StandardCharsets.UTF_8));
      out.writeBytes(p.data());
      out.writeBytes("\r\n".getBytes(StandardCharsets.UTF_8));
    }
    out.writeBytes(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
    return out.toByteArray();
  }

  private static String escape(String s) {
    return s.replace("\\", "\\\\").replace("\"", "%22").replace("\r", "%0D").replace("\n", "%0A");
  }
}
