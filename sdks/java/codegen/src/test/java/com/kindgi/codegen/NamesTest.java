// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class NamesTest {
  @Test
  void pascal() {
    assertThat(Names.pascal("run.finished")).isEqualTo("RunFinished");
    assertThat(Names.pascal("adapter_config")).isEqualTo("AdapterConfig");
    assertThat(Names.pascal("StartRunBody")).isEqualTo("StartRunBody");
    assertThat(Names.pascal("approvals.reviewers.list")).isEqualTo("ApprovalsReviewersList");
    assertThat(Names.pascal("2fa")).isEqualTo("_2fa");
  }

  @Test
  void camelAndMembers() {
    assertThat(Names.camel("runId")).isEqualTo("runId");
    assertThat(Names.camel("adapter_config")).isEqualTo("adapterConfig");
    assertThat(Names.camel("URL")).isEqualTo("url");
    assertThat(Names.camel("default")).isEqualTo("default_");
    assertThat(Names.member("wait")).isEqualTo("wait_");
    assertThat(Names.member("validate")).isEqualTo("validate_");
    assertThat(Names.member("hashCode")).isEqualTo("hashCode_");
    assertThat(OperationPlanner.javaParamName("Idempotency-Key")).isEqualTo("idempotencyKey");
    assertThat(OperationPlanner.javaParamName("X-Supervisor-Id")).isEqualTo("supervisorId");
    assertThat(OperationPlanner.javaParamName("Last-Event-Id")).isEqualTo("lastEventId");
  }

  @Test
  void constants() {
    assertThat(Names.constant("run.finished")).isEqualTo("RUN_FINISHED");
    assertThat(Names.constant("auth-missing")).isEqualTo("AUTH_MISSING");
    assertThat(Names.constant("inProgress")).isEqualTo("IN_PROGRESS");
    assertThat(Names.constant("1h")).isEqualTo("_1H");
    assertThat(Names.constant("")).isEqualTo("EMPTY");
  }

  @Test
  void javadocEscaping() {
    assertThat(Docs.javadoc("Use `a<b>` and @param {x} */"))
        .isEqualTo("Use <code>a&lt;b&gt;</code> and &#64;param &#123;x&#125; *&#47;");
    assertThat(Docs.javadoc("an `unmatched backtick")).isEqualTo("an `unmatched backtick");
  }
}
