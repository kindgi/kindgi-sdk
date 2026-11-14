// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RuntimeSettingsTest {
  @TempDir Path dir;

  @BeforeEach
  void reset() {
    RuntimeSettings.resetWarnings();
  }

  private void devFile(Path at) throws IOException {
    Files.writeString(at.resolve(".kindgirc.json"), "{\"apiUrl\":\"http://127.0.0.1:4000\",\"token\":\"kgi_dev\"}");
  }

  @Test
  void argumentsWinOverTheEnvironment() {
    RuntimeSettings.Settings s =
        RuntimeSettings.resolve("http://a", "t", Map.of("KINDGI_API_URL", "http://b", "KINDGI_API_TOKEN", "u"), dir);
    assertThat(s).isEqualTo(new RuntimeSettings.Settings("http://a", "t"));
  }

  @Test
  void theEnvironmentFillsWhatsMissing() {
    assertThat(RuntimeSettings.resolve(null, null, Map.of("KINDGI_API_URL", "http://b", "KINDGI_API_TOKEN", "u"), dir))
        .isEqualTo(new RuntimeSettings.Settings("http://b", "u"));
  }

  @Test
  void inDevelopmentTheNearestKindgiDevFillsTheRest() throws IOException {
    devFile(dir);
    Path nested = Files.createDirectories(dir.resolve("app/src"));
    assertThat(RuntimeSettings.resolve(null, null, Map.of(), nested)).isEqualTo(new RuntimeSettings.Settings("http://127.0.0.1:4000", "kgi_dev"));
  }

  @Test
  void aUrlThatIsTheRunningKindgiDevsOwnTakesItsToken() throws IOException {
    devFile(dir);
    assertThat(RuntimeSettings.resolve(null, null, Map.of("KINDGI_API_URL", "http://127.0.0.1:4000/"), dir))
        .isEqualTo(new RuntimeSettings.Settings("http://127.0.0.1:4000/", "kgi_dev"));
  }

  @Test
  void aTokenWithNoUrlNeverGoesToTheRunningKindgiDevsUrl() throws IOException {
    devFile(dir);
    assertThatThrownBy(() -> RuntimeSettings.resolve(null, null, Map.of("KINDGI_API_TOKEN", "kgi_prod"), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage(
            "Kindgi: KINDGI_API_TOKEN is set, and KINDGI_API_URL isn't set. The client won't send that token to the URL in "
                + dir.resolve(".kindgirc.json") + ", the running kindgi dev's. Set KINDGI_API_URL and KINDGI_API_TOKEN in"
                + " your env file (.env / .env.local), or pass baseUrl and token to the builder. To use the running kindgi"
                + " dev, set neither.");
    assertThatThrownBy(() -> RuntimeSettings.resolve(null, "kgi_prod", Map.of(), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageStartingWith("Kindgi: the builder's token is passed, and KINDGI_API_URL isn't set.");
  }

  @Test
  void aUrlOtherThanTheRunningKindgiDevsNeverTakesItsToken() throws IOException {
    devFile(dir);
    assertThatThrownBy(() -> RuntimeSettings.resolve(null, null, Map.of("KINDGI_API_URL", "https://kindgi.acme.dev"), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage(
            "Kindgi: KINDGI_API_URL is set, and KINDGI_API_TOKEN isn't set. The token in " + dir.resolve(".kindgirc.json")
                + " is the running kindgi dev's, for http://127.0.0.1:4000 only, so the client won't send it to another"
                + " URL. Set KINDGI_API_URL and KINDGI_API_TOKEN in your env file (.env / .env.local), or pass baseUrl and"
                + " token to the builder. To use the running kindgi dev, set neither.");
    assertThatThrownBy(() -> RuntimeSettings.resolve("https://kindgi.acme.dev", null, Map.of(), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageStartingWith("Kindgi: the builder's baseUrl is passed, and KINDGI_API_TOKEN isn't set.");
  }

  @Test
  void withNoKindgiDevATokenWithNoUrlIsThePlainMissingUrlError() {
    assertThatThrownBy(() -> RuntimeSettings.resolve(null, null, Map.of("KINDGI_API_TOKEN", "kgi_prod"), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageStartingWith("Kindgi: KINDGI_API_URL isn't set. Set it in");
  }

  @Test
  void productionNeverReadsTheDevFile() throws IOException {
    devFile(dir);
    assertThatThrownBy(() -> RuntimeSettings.resolve(null, null, Map.of("KINDGI_ENV", "production"), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessage(
            "Kindgi: KINDGI_API_URL and KINDGI_API_TOKEN aren't set. Set them in your env file (.env / .env.local),"
                + " or pass baseUrl and token to the builder.");
  }

  @Test
  void nothingFoundSaysWhatToSet() {
    assertThatThrownBy(() -> RuntimeSettings.resolve("http://a", null, Map.of(), dir))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("KINDGI_API_TOKEN isn't set")
        .hasMessageContaining("run `kindgi dev` in the app");
  }
}
