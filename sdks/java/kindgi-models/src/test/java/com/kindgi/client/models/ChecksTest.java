// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The checks of a value this client doesn't know: an enum value, a text variant's value, or a
 * union variant read from a newer runtime. They refuse it only in the checks for a body about to
 * be sent; other checks keep it.
 */
class ChecksTest {
  /** An enum value, as a generated enum class holds one. */
  private record State(String asString) implements OpenEnum {
    @Override
    public boolean isKnown() {
      return knownValues().contains(asString);
    }

    @Override
    public List<String> knownValues() {
      return List.of("draft", "live");
    }
  }

  /** A model holding enum values: one, in a list, and in a map. */
  private record Holder(State state, List<State> history, Map<String, State> byRegion) implements Model {
    @Override
    public void validate(Checks checks) {
      checks.nested("state", state);
      checks.nested("history", history);
      checks.nested("byRegion", byRegion);
    }
  }

  private static final State LIVE = new State("live");
  private static final State UNKNOWN = new State("kindgi-test-unknown");

  @Test
  void anEnumValueThisClientDoesntKnowIsRefusedOnlyOnSend() {
    Checks other = new Checks();
    other.known("state", UNKNOWN);
    other.known("baseline", "kindgi-test-unknown", List.of("recorded"));
    assertThat(other.violations()).isEmpty();

    Checks sending = Checks.sending();
    sending.known("state", UNKNOWN);
    sending.known("baseline", "kindgi-test-unknown", List.of("recorded"));
    assertThat(sending.violations())
        .containsExactly("state: must be one of draft, live", "baseline: must be one of recorded");
  }

  @Test
  void aKnownValueAndNoValueAreSent() {
    Checks sending = Checks.sending();
    sending.known("state", LIVE);
    sending.known("state", (OpenEnum) null);
    sending.known("baseline", "recorded", List.of("recorded"));
    sending.known("baseline", (String) null, List.of("recorded"));
    assertThat(sending.violations()).isEmpty();
  }

  @Test
  void aUnionVariantThisClientDoesntKnowIsRefusedOnlyOnSend() {
    Checks other = new Checks();
    other.unrecognized("kind", List.of("tenant", "project"));
    other.unrecognized();
    assertThat(other.violations()).isEmpty();

    Checks sending = Checks.sending();
    sending.unrecognized("kind", List.of("tenant", "project"));
    sending.unrecognized();
    assertThat(sending.violations())
        .containsExactly("kind: must be one of tenant, project", "(value): a variant this client doesn't know can't be sent");
  }

  @Test
  void nestedChecksReachAnEnumValueInAListAndAMapWhereItIs() {
    Map<String, State> byRegion = new LinkedHashMap<>();
    byRegion.put("eu", LIVE);
    byRegion.put("us", UNKNOWN);
    Holder holder = new Holder(UNKNOWN, List.of(LIVE, UNKNOWN), byRegion);

    Checks sending = Checks.sending();
    sending.nested("holder", holder);
    assertThat(sending.violations())
        .containsExactly(
            "holder.state: must be one of draft, live",
            "holder.history[1]: must be one of draft, live",
            "holder.byRegion[us]: must be one of draft, live");

    // A builder's build() runs the other checks: an answer that carries one is kept.
    assertThatCode(holder::validate).doesNotThrowAnyException();
  }

  @Test
  void theSendingChecksThrowWithEveryProblem() {
    Checks sending = Checks.sending();
    new Holder(UNKNOWN, List.of(UNKNOWN), Map.of()).validate(sending);
    assertThatThrownBy(() -> sending.throwIfAny("Holder"))
        .isInstanceOf(ValidationException.class)
        .hasMessage("Holder is invalid: state: must be one of draft, live; history[0]: must be one of draft, live");
  }

  /** A model with a check that isn't only for sending. */
  private record Sized(List<String> items) implements Model {
    @Override
    public void validate(Checks checks) {
      checks.maxItems("items", items, 1);
    }
  }

  @Test
  void aNestedModelIsNamedAfterTheClassItsIn() {
    // As a union's variant is: `StartRunBody.WithAgent is invalid`.
    assertThatThrownBy(() -> new Sized(List.of("a", "b")).validate())
        .isInstanceOf(ValidationException.class)
        .hasMessage("ChecksTest.Sized is invalid: items: must have at most 1 item");
    assertThatThrownBy(() -> new CreateSystemTenantBody.FirstAdmin("admin@acme.test", "").validate())
        .isInstanceOf(ValidationException.class)
        .hasMessage("CreateSystemTenantBody.FirstAdmin is invalid: name: must be at least 1 character long");

    Checks sending = Checks.sending();
    new Holder(UNKNOWN, List.of(), Map.of()).validate(sending);
    assertThatThrownBy(() -> sending.throwIfAny(Holder.class))
        .isInstanceOf(ValidationException.class)
        .hasMessage("ChecksTest.Holder is invalid: state: must be one of draft, live");
  }
}
