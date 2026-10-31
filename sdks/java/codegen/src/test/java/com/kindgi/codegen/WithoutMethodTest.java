// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The operations the client has no method for are left out, and named in {@code WITHOUT_METHOD}. */
class WithoutMethodTest {
  private static final Path API = Path.of("../../../packages/api/openapi.json");

  private static Map<String, Object> obj(Object... kv) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      m.put((String) kv[i], kv[i + 1]);
    }
    return m;
  }

  private static OperationPlanner plan(Map<String, Object> paths) {
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("openapi", "3.1.0");
    d.put("info", Map.of("title", "t", "version", "1"));
    d.put("paths", paths);
    d.put("components", Map.of("schemas", Map.of()));
    return Generator.plan(d).operations();
  }

  @Test
  void aStreamedBodyHasNoMethod() {
    Map<String, Object> csv = obj("text/csv", obj("schema", obj("type", "string")));
    Map<String, Object> op =
        obj(
            "operationId", "widgets.export",
            "x-kindgi-streamed", true,
            "responses", obj("200", obj("description", "the widgets", "content", csv)));
    OperationPlanner ops = plan(obj("/widgets/export", obj("get", op)));
    assertThat(ops.skipped).containsExactly("widgets.export");
    assertThat(ops.ops).isEmpty();
  }

  @Test
  void theApisExportHasNoMethod() {
    OperationPlanner ops = Generator.plan(Generator.read(API)).operations();
    assertThat(ops.skipped).contains("corrections.export");
    assertThat(ops.ops).noneMatch(op -> op.id.equals("corrections.export"));
  }
}
