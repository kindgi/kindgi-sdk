// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.compat;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.kindgi.client.models.LiveScope;
import com.kindgi.client.models.LiveScopeTenant;
import com.kindgi.client.models.PatchScheduleBody;
import com.kindgi.client.models.PromptRef;
import com.kindgi.client.models.StartRunBody;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * The client in a Spring Boot 3 app: Boot manages Jackson 2 (and so jackson-annotations), the
 * client brings Jackson 3. The client must work there, and Boot's own Jackson 2 mapper must write
 * the client's models as the API spells them.
 */
@SpringBootTest(classes = SpringBoot3Test.App.class)
class SpringBoot3Test {
  @SpringBootApplication
  static class App {}

  @Autowired ObjectMapper bootMapper;

  @Test
  void theClientWorksWithBootsJacksonVersions() throws Exception {
    Compat.clientRoundTrips();
    Compat.clientCallsAServer();
  }

  @Test
  void bootsJackson2MapperWritesTheModelsAsTheApiSpellsThem() throws Exception {
    assertThat(bootMapper.writeValueAsString(StartRunBody.WithAgent.builder().agent("acme.bookkeeper").input(Map.of("userMessage", "hi")).build()))
        .isEqualTo("{\"agent\":\"acme.bookkeeper\",\"input\":{\"userMessage\":\"hi\"}}");
    assertThat(bootMapper.writeValueAsString(PatchScheduleBody.builder().label(null).build())).isEqualTo("{\"label\":null}");
    assertThat(bootMapper.readValue("{\"prompt\":\"acme.tone\",\"version\":\"^1.0.0\"}", PromptRef.class))
        .isEqualTo(new PromptRef("acme.tone", "^1.0.0"));
    assertThat(bootMapper.readValue("{\"kind\":\"tenant\"}", LiveScope.class)).isInstanceOf(LiveScopeTenant.class);
    System.out.println("[compat] Boot " + org.springframework.boot.SpringBootVersion.getVersion() + ": " + Compat.versions());
  }
}
