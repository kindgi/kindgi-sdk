// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.log.Causes;
import com.kindgi.log.Redaction;
import com.kindgi.pack.internal.Json;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.UnaryOperator;

/**
 * What a thrown error says in a failed call's answer, as the TypeScript service says it: its
 * message masked, with its causes ({@link Causes}), and its {@code cause} field, each with the
 * call's own values taken out first.
 */
final class ErrorText {
  private ErrorText() {}

  /**
   * A secret of fewer characters isn't looked for. It would turn up inside ordinary words, and
   * masking each of those would garble the message without hiding the secret.
   */
  static final int MIN_SECRET_LENGTH = 4;

  /**
   * The error for a failure's message: {@code Name: message} as {@link Throwable#toString()} says
   * it, masked with the full mask ({@link Redaction#scrubText(String, boolean)}), then its causes.
   * The message reaches the run's record, the console and the model, which are more readers than a
   * log's. Text with no cause and no secret shape reads as it did.
   *
   * @param e the error
   * @param withoutValues the call's values taken out ({@link #withoutValues}); {@link
   *     UnaryOperator#identity()} for a failure with no call
   * @return what it says
   */
  static String said(Throwable e, UnaryOperator<String> withoutValues) {
    return Redaction.scrubText(withoutValues.apply(String.valueOf(e)), true) + Causes.describe(e, withoutValues);
  }

  /**
   * The error for a failure's {@code cause} field: its class's name, its message and its printed
   * stack (its causes' too), with the call's values taken out.
   *
   * @param e the error
   * @param withoutValues the call's values taken out ({@link #withoutValues})
   * @return the field
   */
  static Map<String, Object> cause(Throwable e, UnaryOperator<String> withoutValues) {
    StringWriter stack = new StringWriter();
    e.printStackTrace(new PrintWriter(stack));
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("name", e.getClass().getName());
    out.put("message", withoutValues.apply(String.valueOf(e.getMessage())));
    out.put("stack", withoutValues.apply(stack.toString()));
    return out;
  }

  /**
   * A text with the call's values replaced by {@code [redacted]}: first each connection's token,
   * wherever the text spells it, then each secret ({@link #MIN_SECRET_LENGTH} characters or more;
   * a value that isn't a string is passed over), as it is or escaped the way a JSON string writes
   * it, for a request body quoted in a message. A secret's first part counts too, up to the last
   * place in it where the text stops: a line break, the text's end, or just before {@code "...},
   * where a quoted value was shortened. So a key of several lines that the text quotes only in part
   * loses every line up to the one where the text goes on differently. Matches that overlap or
   * touch become one {@code [redacted]}.
   *
   * @param ctx the call's context
   * @return the call's values taken out of a text
   */
  static UnaryOperator<String> withoutValues(ToolContext ctx) {
    Set<String> tokens = new LinkedHashSet<>();
    for (ToolConnection connection : ctx.connections().values()) {
      if (!connection.accessToken().isEmpty()) {
        tokens.add(connection.accessToken());
      }
    }
    Set<String> spellings = new LinkedHashSet<>();
    for (Object secret : ctx.secrets().values()) {
      if (secret instanceof String s && s.length() >= MIN_SECRET_LENGTH) {
        spellings.add(s);
        String written = Json.compactString(s);
        spellings.add(written.substring(1, written.length() - 1));
      }
    }
    if (tokens.isEmpty() && spellings.isEmpty()) {
      return UnaryOperator.identity();
    }
    List<String> byToken = new ArrayList<>(tokens);
    List<String> bySecret = new ArrayList<>(spellings);
    return text -> masked(tokened(text, byToken), bySecret);
  }

  /** {@code text} with every place a token spells replaced. */
  private static String tokened(String text, List<String> tokens) {
    boolean[] hidden = new boolean[text.length()];
    for (String token : tokens) {
      for (int at = text.indexOf(token); at != -1; at = text.indexOf(token, at + 1)) {
        Arrays.fill(hidden, at, at + token.length(), true);
      }
    }
    return joined(text, hidden);
  }

  /**
   * {@code text} with every stretch a secret spells, whole or as a first part up to where the text
   * stops, replaced.
   */
  private static String masked(String text, List<String> spellings) {
    boolean[] hidden = new boolean[text.length()];
    for (String spelling : spellings) {
      // Every place the secret's first characters appear: from each, how much of it the text spells there.
      String opening = spelling.substring(0, MIN_SECRET_LENGTH);
      for (int at = text.indexOf(opening); at != -1; at = text.indexOf(opening, at + 1)) {
        Arrays.fill(hidden, at, at + hiddenLength(text, at, spelling), true);
      }
    }
    return joined(text, hidden);
  }

  /**
   * How many characters of {@code text} from {@code at} are {@code spelling}'s to hide: all it
   * spells there when that's the whole of it; else up to the last place in what it spells, {@link
   * #MIN_SECRET_LENGTH} characters in or more, where the text stops; else none.
   */
  private static int hiddenLength(String text, int at, String spelling) {
    int run = 0;
    while (run < spelling.length() && at + run < text.length() && text.charAt(at + run) == spelling.charAt(run)) {
      run++;
    }
    if (run == spelling.length()) {
      return run;
    }
    for (int end = run; end >= MIN_SECRET_LENGTH; end--) {
      if (stopsAt(text, at + end)) {
        return end;
      }
    }
    return 0;
  }

  private static boolean stopsAt(String text, int at) {
    return at == text.length() || text.charAt(at) == '\n' || text.charAt(at) == '\r' || text.startsWith("\"...", at);
  }

  /** {@code text} with each run of hidden characters as one {@code [redacted]}. */
  private static String joined(String text, boolean[] hidden) {
    StringBuilder out = new StringBuilder(text.length());
    for (int i = 0; i < text.length(); i++) {
      if (!hidden[i]) {
        out.append(text.charAt(i));
      } else if (i == 0 || !hidden[i - 1]) {
        out.append(Redaction.REDACTED);
      }
    }
    return out.toString();
  }
}
