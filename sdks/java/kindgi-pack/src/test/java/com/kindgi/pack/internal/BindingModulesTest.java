// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.kindgi.pack.testmodule.SnakeNames;
import com.kindgi.pack.testmodule.SnakeNamesModule;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The app's Jackson modules (here {@code SnakeNamesModule}, from the test classpath's
 * {@code META-INF/services}) apply to tool inputs, outputs and their schemas, and never to the wire.
 */
class BindingModulesTest {
  @SnakeNames
  record Person(String firstName, String lastName) {}

  record Plain(String firstName) {}

  @Test
  void theSchemaNamesPropertiesAsTheModuleDoes() {
    assertThat(SchemaDeriver.schema(Person.class)).containsEntry("properties", Map.of(
        "first_name", Map.of("type", "string"), "last_name", Map.of("type", "string")))
        .containsEntry("required", List.of("first_name", "last_name"));
  }

  @Test
  void inputsBindAndOutputsWriteAsTheModuleDoes() {
    assertThat(Json.bind(Map.of("first_name", "Ada", "last_name", "Lovelace"), Person.class))
        .isEqualTo(new Person("Ada", "Lovelace"));
    assertThat(Json.unbind(new Person("Ada", "Lovelace"))).isEqualTo(Map.of("first_name", "Ada", "last_name", "Lovelace"));
  }

  @Test
  void typesTheModuleDoesntMarkKeepTheirNames() {
    assertThat(SchemaDeriver.schema(Plain.class)).containsEntry("properties", Map.of("firstName", Map.of("type", "string")));
    assertThat(Json.unbind(new Plain("Ada"))).isEqualTo(Map.of("firstName", "Ada"));
  }

  @Test
  void theWireIgnoresTheAppsModules() {
    assertThat(Json.plain(new Person("Ada", "Lovelace"))).isEqualTo(Map.of("firstName", "Ada", "lastName", "Lovelace"));
    assertThat(Json.mapper().getRegisteredModuleIds()).doesNotContain(SnakeNamesModule.class.getName());
    assertThat(Json.binding().getRegisteredModuleIds()).contains(SnakeNamesModule.class.getName());
  }
}
