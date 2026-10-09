// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** {@link SchemaValidator#explain}: one issue that says what's wrong, through a discriminated oneOf. */
class ExplainTest {
  private final SchemaValidator flow = Specs.validator("flow");

  private static Map<String, Object> flowWith(Map<String, Object> node) {
    return Map.of("id", "acme.f", "version", "1.0.0", "nodes", List.of(node),
        "edges", List.of(Map.of("id", "e1", "from", "$start", "to", "x"), Map.of("id", "e2", "from", "x", "to", "$end")));
  }

  @Test
  void aValidFlowHasNoIssue() {
    assertThat(flow.explain(flowWith(Map.of("id", "x", "kind", "tool", "ref", "acme.t")))).isNull();
  }

  @Test
  void anUnknownKindNamesTheKinds() {
    Map<String, Object> issue = flow.explain(flowWith(Map.of("id", "x", "kind", "toool", "ref", "acme.t")));
    assertThat(issue).containsEntry("instancePath", "/nodes/0/kind").containsEntry("keyword", "enum");
    assertThat((String) issue.get("message")).startsWith("must be one of \"").contains("\"tool\"");
  }

  @Test
  void aToolNodeSaysItsOwnProblem() {
    Map<String, Object> issue = flow.explain(flowWith(Map.of("id", "x", "kind", "tool")));
    assertThat(issue).containsEntry("instancePath", "/nodes/0").containsEntry("keyword", "required")
        .containsEntry("params", Map.of("missingProperty", "ref"));
  }

  @Test
  void anUndiscriminatedIssueIsTheFirst() {
    Map<String, Object> issue = flow.explain(Map.of("id", "acme.f", "version", "1.0.0", "nodes", List.of(), "edges", List.of(), "colour", 1));
    assertThat(issue).containsEntry("keyword", "additionalProperties").containsEntry("params", Map.of("additionalProperty", "colour"));
  }
}
