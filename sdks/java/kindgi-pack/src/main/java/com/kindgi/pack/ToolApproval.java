// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.SchemaValidator;
import com.kindgi.pack.internal.Specs;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.jspecify.annotations.Nullable;

/**
 * How an approval of a call to a tool reads ({@link Tool.Builder#approval}). Each text holds
 * {@code {field}} placeholders, each naming a required top-level field of the tool's input whose
 * type is a string, a number, an integer or a boolean (or an enum of those): the tool refuses any
 * other when it's built. A call's arguments fill them in as plain text, on one line, cut when long.
 *
 * <p>The words stay behind sign-in: the approval keeps them in its context, with the call's
 * arguments, and its title stays {@code Approve a call to <tool id>}, since the title goes out in
 * the reviewer's mail and the {@code approval.requested} event, which never carry a call's
 * arguments.
 *
 * <pre>{@code
 * Tool.define("acme.refund")
 *     .input(Input.class)
 *     .approval(
 *         ToolApproval.titled("Refund {amount} on order #{orderId}")
 *             .withSummary("{reason}")
 *             .withAbout("acme.order", "{orderId}"))
 * }</pre>
 *
 * @param title what the reviewer approves, on one line
 * @param summary more for the reviewer, or {@code null}
 * @param about what the call acts on, or {@code null}
 */
public record ToolApproval(String title, @Nullable String summary, @Nullable About about) {
  private static final Pattern PLACEHOLDER = Pattern.compile("\\{(\\w+)\\}");
  private static final Pattern BRACE = Pattern.compile("[{}]");
  private static final Set<Object> SCALAR_TYPES = Set.of("string", "number", "integer", "boolean");

  /** {@code title} is required. */
  public ToolApproval {
    Objects.requireNonNull(title, "title");
  }

  /**
   * What a call acts on, so the reviewer can tell which one.
   *
   * @param kind the kind of thing ({@code acme.order})
   * @param id which one: it holds at least one {@code {field}} placeholder ({@code {orderId}})
   */
  public record About(String kind, String id) {
    /** Both are required. */
    public About {
      Objects.requireNonNull(kind, "kind");
      Objects.requireNonNull(id, "id");
    }
  }

  /**
   * @param title what the reviewer approves, on one line ({@code Refund {amount} on order
   *     #{orderId}})
   * @return an approval with only a title
   */
  public static ToolApproval titled(String title) {
    return new ToolApproval(title, null, null);
  }

  /**
   * @param summary more for the reviewer ({@code {reason}})
   * @return this approval with that summary
   */
  public ToolApproval withSummary(String summary) {
    return new ToolApproval(title, Objects.requireNonNull(summary, "summary"), about);
  }

  /**
   * @param kind the kind of thing the call acts on ({@code acme.order})
   * @param id which one ({@code {orderId}})
   * @return this approval with that {@code about}
   */
  public ToolApproval withAbout(String kind, String id) {
    return new ToolApproval(title, summary, new About(kind, id));
  }

  /** The approval as the pack's index carries it. */
  Map<String, Object> toIndexMap() {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("title", title);
    if (summary != null) {
      m.put("summary", summary);
    }
    if (about != null) {
      Map<String, Object> a = new LinkedHashMap<>();
      a.put("kind", about.kind());
      a.put("id", about.id());
      m.put("about", a);
    }
    return m;
  }

  /** {@code approval} in {@code tool.schema.json}, loaded on first use. */
  private static final class Shape {
    @SuppressWarnings("unchecked")
    static final SchemaValidator VALIDATOR =
        new SchemaValidator(
            (Map<String, Object>)
                ((Map<String, Object>) Specs.schema("tool").get("properties")).get("approval"));
  }

  /**
   * Why this approval can't be filled from the calls of a tool with this input, if it can't: its
   * shape first ({@code tool.schema.json}), then each text in turn ({@code title}, {@code
   * summary}, {@code about.id}), first wins, each named by its path. The same rules {@code
   * defineTool} applies.
   */
  @Nullable String problem(Map<String, Object> inputSchema) {
    List<Map<String, Object>> issues = Shape.VALIDATOR.issues(toIndexMap());
    if (!issues.isEmpty()) {
      String found =
          issues.stream()
              .map(
                  issue -> {
                    Object path = issue.get("instancePath");
                    String at = (path == null || path.toString().isEmpty()) ? "/" : path.toString();
                    return at + " " + issue.get("message");
                  })
              .collect(Collectors.joining("; "));
      return "not a valid approval: " + found;
    }
    Map<?, ?> properties =
        inputSchema.get("properties") instanceof Map<?, ?> map ? map : Map.of();
    Set<?> required =
        inputSchema.get("required") instanceof List<?> list ? new HashSet<>(list) : Set.of();
    List<String[]> texts = new ArrayList<>();
    texts.add(new String[] {"approval.title", title});
    if (summary != null) {
      texts.add(new String[] {"approval.summary", summary});
    }
    if (about != null) {
      texts.add(new String[] {"approval.about.id", about.id()});
    }
    for (String[] text : texts) {
      String why = textProblem(text[0], text[1], properties, required);
      if (why != null) {
        return text[0] + " " + why;
      }
    }
    return null;
  }

  private static @Nullable String textProblem(
      String path, String text, Map<?, ?> properties, Set<?> required) {
    if (BRACE.matcher(PLACEHOLDER.matcher(text).replaceAll("")).find()) {
      return "has a brace that isn't part of a {field} placeholder";
    }
    List<String> names = new ArrayList<>();
    Matcher m = PLACEHOLDER.matcher(text);
    while (m.find()) {
      names.add(m.group(1));
    }
    if (path.equals("approval.about.id") && names.isEmpty()) {
      return "must hold at least one {field} placeholder";
    }
    for (String name : names) {
      String why = fieldProblem(name, properties, required);
      if (why != null) {
        return why;
      }
    }
    return null;
  }

  private static @Nullable String fieldProblem(
      String name, Map<?, ?> properties, Set<?> required) {
    if (!properties.containsKey(name)) {
      return "names {" + name + "}, which isn't a field of the input";
    }
    if (!required.contains(name)) {
      return "names {" + name + "}, an optional field of the input: a call may leave it out";
    }
    if (!isScalarSchema(properties.get(name))) {
      return "names {"
          + name
          + "}, a field of the input that isn't a string, a number, an integer or a boolean";
    }
    return null;
  }

  private static boolean isScalarValue(@Nullable Object value) {
    return value instanceof String || value instanceof Number || value instanceof Boolean;
  }

  /**
   * Whether a field's schema only lets a string, a number, an integer or a boolean through (or an
   * enum of those): a value that fills a line of text. {@code null}, objects, arrays and unions
   * don't.
   */
  private static boolean isScalarSchema(@Nullable Object schema) {
    if (!(schema instanceof Map<?, ?> s)) {
      return false;
    }
    if (s.get("enum") instanceof List<?> values) {
      return !values.isEmpty() && values.stream().allMatch(ToolApproval::isScalarValue);
    }
    if (s.containsKey("const")) {
      return isScalarValue(s.get("const"));
    }
    Object declared = s.get("type");
    List<?> types = declared instanceof List<?> list ? list : Collections.singletonList(declared);
    return !types.isEmpty() && types.stream().allMatch(t -> t != null && SCALAR_TYPES.contains(t));
  }
}
