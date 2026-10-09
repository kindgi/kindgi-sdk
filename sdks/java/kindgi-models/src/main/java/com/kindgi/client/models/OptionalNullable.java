// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.models;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;
import java.util.NoSuchElementException;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * A property that can be absent, an explicit {@code null}, or a value. An update uses the
 * difference: leaving a property out keeps it as it is, and {@code null} clears it ({@code
 * PatchScheduleBody.builder().label(null)} clears the label; not calling {@code label} keeps it).
 *
 * @param <T> the value's type
 */
public final class OptionalNullable<T> {
  private static final OptionalNullable<?> ABSENT = new OptionalNullable<>(false, null);
  private static final OptionalNullable<?> NULL = new OptionalNullable<>(true, null);

  private final boolean present;
  private final @Nullable T value;

  private OptionalNullable(boolean present, @Nullable T value) {
    this.present = present;
    this.value = value;
  }

  /**
   * Left out.
   *
   * @param <T> the value's type
   * @return the absent value
   */
  @SuppressWarnings("unchecked")
  public static <T> OptionalNullable<T> absent() {
    return (OptionalNullable<T>) ABSENT;
  }

  /**
   * A value, or an explicit {@code null}.
   *
   * @param <T> the value's type
   * @param value the value; {@code null} for an explicit {@code null}
   * @return the present value
   */
  @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
  @SuppressWarnings("unchecked")
  public static <T> OptionalNullable<T> of(@Nullable T value) {
    return value == null ? (OptionalNullable<T>) NULL : new OptionalNullable<>(true, value);
  }

  /** @return whether the property is there (a value or an explicit {@code null}) */
  public boolean isPresent() {
    return present;
  }

  /** @return whether the property is left out */
  public boolean isAbsent() {
    return !present;
  }

  /** @return whether the property is there with a value (not {@code null}) */
  public boolean hasValue() {
    return value != null;
  }

  /**
   * The value: {@code null} for an explicit {@code null}.
   *
   * @return the value
   * @throws NoSuchElementException when the property is absent
   */
  public @Nullable T get() {
    if (!present) {
      throw new NoSuchElementException("absent");
    }
    return value;
  }

  /**
   * The value, or {@code other} when absent or {@code null}.
   *
   * @param other the fallback
   * @return the value or the fallback
   */
  public @Nullable T orElse(@Nullable T other) {
    return value != null ? value : other;
  }

  /** @return the JSON value: the value, or {@code null} (an absent one isn't written at all) */
  @JsonValue
  public @Nullable T jsonValue() {
    return value;
  }

  @Override
  public boolean equals(Object other) {
    return other instanceof OptionalNullable
        && ((OptionalNullable<?>) other).present == present
        && Objects.equals(((OptionalNullable<?>) other).value, value);
  }

  @Override
  public int hashCode() {
    return Objects.hash(present, value);
  }

  @Override
  public String toString() {
    return !present ? "absent" : String.valueOf(value);
  }

  /**
   * Leaves an absent property out of the JSON ({@code @JsonInclude(value = CUSTOM, valueFilter =
   * AbsentFilter.class)}).
   */
  public static final class AbsentFilter {
    /** For Jackson. */
    public AbsentFilter() {}

    @Override
    public boolean equals(Object other) {
      return other == null || (other instanceof OptionalNullable && ((OptionalNullable<?>) other).isAbsent());
    }

    @Override
    public int hashCode() {
      return 0;
    }
  }
}
