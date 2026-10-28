// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** The formats as {@code ajv-formats} checks them. */
class FormatsTest {
  @Test
  void theRegexFormatIsWhatJavaScriptReadsWithoutFlags() {
    assertThat(Formats.accepts("regex", "[\\d-a]")).isTrue();
    assertThat(Formats.accepts("regex", "(?<a>.)\\k<a>")).isTrue();
    assertThat(Formats.accepts("regex", "(")).isFalse();
    assertThat(Formats.accepts("regex", "(?P<a>.)")).isFalse();
    assertThat(Formats.accepts("regex", "[z-a]")).isFalse();
    // ajv-formats refuses a \Z after a character, which JavaScript reads as Z.
    assertThat(Formats.accepts("regex", "a\\Z")).isFalse();
  }
}
