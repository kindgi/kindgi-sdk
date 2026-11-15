// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.log;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.function.UnaryOperator;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * What an error's causes add to its message: {@code ""} when it has none, else {@code ; caused by
 * <Name> [<code>]: <message>} for each, in order. A tool's error then says why, where the error
 * alone says only what failed:
 *
 * <pre>{@code
 * java.lang.IllegalStateException: lookup failed; caused by ConnectException: Connection refused
 * }</pre>
 *
 * <ul>
 *   <li><b>{@code Name [code]: message}</b>, named as a record's {@code err} names an error: its
 *       class's simple name, and its code when it has one (a public {@code code()} or {@code
 *       getCode()}). The code is left out when the cause's message already holds it, and the
 *       message when it's empty.
 *   <li><b>Three causes at most</b> ({@link Throwable#getCause()}) are looked at. One whose message
 *       its effect's message already holds, its code too when it has one, is passed over and the
 *       next is looked at: {@code new RuntimeException(cause)} already says its cause. One with an
 *       empty message never is. An error met a second time (a cycle) ends the walk.
 *   <li><b>Each cause is masked with the full mask</b> ({@link Redaction#scrubText(String,
 *       boolean)}), <b>then made one line,</b> then cut to {@link #MAX_CAUSE_CHARS} characters with
 *       {@code …}. The cut never splits a word, so no part of a token shows past it; a word longer
 *       than the cut is left out whole.
 * </ul>
 *
 * It never throws. The same rules as {@code @kindgi/log}'s {@code describeCauses} and {@code
 * kindgi.log}'s {@code describe_causes}.
 */
public final class Causes {
  private Causes() {}

  /** The most characters a cause is said in, {@code …} included. */
  public static final int MAX_CAUSE_CHARS = 500;

  /** How many causes are said: the error and three below it, as a record's {@code err} has. */
  private static final int CAUSES = 3;

  private static final Pattern SPACES = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);

  /**
   * @param err the error
   * @return what its causes add to its message, or {@code ""}
   */
  public static String describe(Throwable err) {
    return describe(err, UnaryOperator.identity());
  }

  /**
   * @param err the error
   * @param first what each message and code goes through before anything else: a caller's own
   *     values taken out (a pack call's secrets), where the mask, the one line or the cut could
   *     otherwise leave part of one that a match on the whole value no longer finds
   * @return what its causes add to its message, or {@code ""}
   */
  public static String describe(Throwable err, UnaryOperator<String> first) {
    try {
      StringBuilder parts = new StringBuilder();
      String effect = first.apply(messageOf(err));
      Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
      seen.add(err);
      Throwable cause = err.getCause();
      for (int looked = 0; looked < CAUSES && cause != null && seen.add(cause); looked++) {
        String message = first.apply(messageOf(cause));
        String found = Errors.code(cause);
        String code = found == null ? null : first.apply(found);
        if (!passedOver(message, code, effect)) {
          String coded = code != null && !message.contains(code) ? " [" + code + "]" : "";
          String words = message.isEmpty() ? "" : ": " + message;
          parts.append("; caused by ").append(shown(Errors.name(cause) + coded + words));
        }
        effect = message;
        cause = cause.getCause();
      }
      return parts.toString();
    } catch (RuntimeException | LinkageError e) {
      return "";
    }
  }

  private static String messageOf(Throwable t) {
    String message = t.getMessage();
    return message == null ? "" : message;
  }

  /**
   * Whether a cause adds nothing to its effect: its message isn't empty and the effect's message
   * holds it, and its code too when it has one.
   */
  private static boolean passedOver(String message, @Nullable String code, String effect) {
    if (message.isEmpty() || !effect.contains(message)) {
      return false;
    }
    return code == null || effect.contains(code);
  }

  /** A cause's text masked, on one line, cut short. */
  private static String shown(String text) {
    return cut(SPACES.matcher(Redaction.scrubText(text, true)).replaceAll(" ").strip());
  }

  /**
   * {@code text} at {@link #MAX_CAUSE_CHARS} characters at most, {@code …} included. A cut that
   * lands inside a word goes back to the space before it.
   */
  private static String cut(String text) {
    if (text.length() <= MAX_CAUSE_CHARS) {
      return text;
    }
    int end = MAX_CAUSE_CHARS - 1;
    boolean inWord = text.charAt(end) != ' ' && text.charAt(end - 1) != ' ';
    String kept = inWord ? text.substring(0, Math.max(0, text.lastIndexOf(' ', end - 1))) : text.substring(0, end);
    return kept.stripTrailing() + "…";
  }
}
