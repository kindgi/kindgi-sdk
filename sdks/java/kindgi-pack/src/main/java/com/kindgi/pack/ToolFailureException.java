// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.Json;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * A tool's own failure: the tool ran, and says this call can't give an answer. Throw it with the
 * tool's code for why, in kebab case, and words for a person: {@code throw new
 * ToolFailureException("order-not-found", "No order " + orderId, Map.of("orderId", orderId))}. The
 * call answers {@code tool-failed}, with the code as {@code reason}, the message as written and the
 * details; the runtime's run reads the same.
 *
 * <ul>
 *   <li>The code is a fixed word of the tool's, never built from its input: runs are grouped by it,
 *       and it outlives the run's erasure.
 *   <li>The message is cut at 1,000 characters. The details reach the run's failure and the model,
 *       so they never hold a secret, and never a wait or a retry hint.
 *   <li>An outcome the caller acts on goes in the output schema ({@code found: false}); a bug just
 *       throws. A {@code ToolFailureException} doesn't undo what the tool did before it.
 * </ul>
 */
public final class ToolFailureException extends RuntimeException {
  private static final long serialVersionUID = 1L;

  /** The code the call answers. */
  public static final String CODE = "tool-failed";

  /** The most characters of the message that are kept. */
  public static final int MESSAGE_MAX = 1000;

  /** The most bytes the details may take as JSON (UTF-8). */
  public static final int DETAILS_MAX_BYTES = 4096;

  private static final Pattern TOOL_CODE = Pattern.compile("[a-z][a-z0-9-]{0,63}");

  private final String code;
  private final @Nullable Map<String, Object> details;

  /**
   * @param code the tool's code for why, in kebab case ({@code order-not-found})
   * @param message words for a person, said as written; not empty
   * @throws IllegalArgumentException when the code isn't kebab case or the message is empty; the
   *     call then fails as a crash ({@code handler-throw}) that says why
   */
  public ToolFailureException(String code, String message) {
    this(code, message, null);
  }

  /**
   * @param code the tool's code for why, in kebab case ({@code order-not-found})
   * @param message words for a person, said as written; not empty
   * @param details the tool's facts, a JSON object of at most 4 KiB; or null
   * @throws IllegalArgumentException when the code isn't kebab case, the message is empty, or the
   *     details aren't a JSON object of at most 4 KiB; the call then fails as a crash ({@code
   *     handler-throw}) that says why
   */
  public ToolFailureException(String code, String message, @Nullable Map<String, ?> details) {
    super(checkedMessage(code, message));
    this.code = code;
    this.details = details == null ? null : jsonDetails(code, details);
  }

  /** @return the tool's code for why the call failed ({@code order-not-found}) */
  public String code() {
    return code;
  }

  /** @return the tool's facts, as a JSON copy of what it gave; null when it gave none */
  public @Nullable Map<String, Object> details() {
    return details;
  }

  private static String checkedMessage(@Nullable String code, @Nullable String message) {
    if (code == null || !TOOL_CODE.matcher(code).matches()) {
      String shown = code == null ? "null" : Json.compactString(code.length() > 80 ? code.substring(0, 80) : code);
      throw new IllegalArgumentException(
          "ToolFailureException's code must be kebab case, a letter first, at most 64 characters: " + shown);
    }
    if (message == null || message.isBlank()) {
      throw new IllegalArgumentException("ToolFailureException \"" + code + "\" needs a message for a person");
    }
    if (message.codePointCount(0, message.length()) <= MESSAGE_MAX) {
      return message;
    }
    return message.substring(0, message.offsetByCodePoints(0, MESSAGE_MAX));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> jsonDetails(String code, Map<String, ?> details) {
    Object plain;
    byte[] json;
    try {
      plain = Json.unbind(details);
      Json.requireFinite(plain);
      json = Json.compact(plain);
    } catch (IllegalArgumentException e) {
      throw new IllegalArgumentException("ToolFailureException \"" + code + "\"'s details aren't JSON", e);
    }
    if (!(plain instanceof Map)) {
      throw new IllegalArgumentException("ToolFailureException \"" + code + "\"'s details must be a JSON object");
    }
    if (json.length > DETAILS_MAX_BYTES) {
      throw new IllegalArgumentException("ToolFailureException \"" + code + "\"'s details take " + json.length
          + " bytes as JSON, more than " + DETAILS_MAX_BYTES);
    }
    return Collections.unmodifiableMap(new LinkedHashMap<>((Map<String, Object>) plain));
  }
}
