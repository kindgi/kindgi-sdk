// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * An app's own Jackson 2 mapper, as old as Spring Boot 3.2's (2.15), reads and writes the models
 * through their annotations, with the API's wire names: the client's own codec isn't involved.
 */
class AppJacksonTest {
  private final ObjectMapper app =
      new ObjectMapper()
          .registerModule(new JavaTimeModule())
          .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
          .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);

  @Test
  void writesWithWireNames() throws Exception {
    assertThat(app.writeValueAsString(StartRunBody.WithAgent.builder().agent("acme.bookkeeper").input(Map.of("userMessage", "hi")).build()))
        .isEqualTo("{\"agent\":\"acme.bookkeeper\",\"input\":{\"userMessage\":\"hi\"}}");
    assertThat(app.writeValueAsString(StartRunOptions.builder().wait_(true).build())).isEqualTo("{\"wait\":true}");
  }

  @Test
  void writesAnUpdatesExplicitNullAndLeavesOutAnAbsentProperty() throws Exception {
    assertThat(app.writeValueAsString(PatchScheduleBody.builder().label(null).build())).isEqualTo("{\"label\":null}");
    assertThat(app.writeValueAsString(PatchScheduleBody.builder().flowVersion("2").build())).isEqualTo("{\"flowVersion\":\"2\"}");
  }

  @Test
  void readsRecordsTaggedUnionsAndEnums() throws Exception {
    assertThat(app.readValue("{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}", PromptRef.class)).isEqualTo(new PromptRef("acme.tone", "^1.0.0"));
    assertThat(app.readValue("{\"kind\":\"tenant\"}", LiveScope.class)).isInstanceOf(LiveScopeTenant.class);
    assertThat(app.readValue("{\"kind\":\"galaxy\",\"arm\":3}", LiveScope.class)).isInstanceOf(LiveScope.Unrecognized.class);
    assertThat(app.readValue("\"hibernating\"", Run.Status.class).value()).isEqualTo(Run.Status.Value.UNRECOGNIZED);
  }
}
