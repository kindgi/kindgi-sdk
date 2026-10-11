// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.jspecify.annotations.Nullable;

/**
 * A JSON Schema (Draft 2020-12) validator for the keywords Kindgi's packs use, reporting issues
 * as Ajv reports them ({@code allErrors}): the TypeScript pack service validates with Ajv, and
 * the Java one must answer the same. Ajv's own verdicts on a corpus of schemas and values are
 * the referee (the {@code ajv} test oracle).
 *
 * <p>Like Ajv's strict mode, it refuses a schema with a keyword or a format it doesn't know,
 * rather than ignoring it.
 */
public final class SchemaValidator {
  /** The keywords this validator checks or carries. */
  static final Set<String> KEYWORDS =
      Set.of(
          "$schema", "$id", "$comment", "$defs", "$ref", "title", "description", "default",
          "examples", "deprecated", "readOnly", "writeOnly", "type", "enum", "const", "properties",
          "required", "additionalProperties", "propertyNames", "minProperties", "maxProperties",
          "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength",
          "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
          "multipleOf", "oneOf", "anyOf", "allOf", "not");
  private static final Set<String> TYPES = Set.of("null", "boolean", "object", "array", "number", "integer", "string");

  private final Map<String, Object> root;
  private final Map<String, Pattern> patterns = new HashMap<>();

  /**
   * @param schema the schema
   * @throws SchemaException when it uses a keyword, a format or a {@code $ref} this validator
   *     doesn't support, or isn't a valid schema
   */
  public SchemaValidator(Map<String, Object> schema) {
    this.root = Objects.requireNonNull(schema);
    compile(schema, "#");
  }

  /** The schema isn't one this validator can check. */
  public static final class SchemaException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    SchemaException(String message) {
      super(message);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Compiling: the schema is checked once, so validating never meets an unknown keyword.
  // ---------------------------------------------------------------------------------------------

  @SuppressWarnings("unchecked")
  private void compile(Object node, String at) {
    if (node instanceof Boolean) {
      return;
    }
    if (!(node instanceof Map)) {
      throw new SchemaException(at + ": a schema must be an object or a boolean");
    }
    Map<String, Object> s = (Map<String, Object>) node;
    for (Map.Entry<String, Object> e : s.entrySet()) {
      String k = e.getKey();
      if (!KEYWORDS.contains(k)) {
        throw new SchemaException(at + ": unknown keyword \"" + k + "\"");
      }
      Object v = e.getValue();
      switch (k) {
        case "type":
          List<Object> types = v instanceof List ? (List<Object>) v : List.of(v);
          for (Object t : types) {
            if (!TYPES.contains(t)) {
              throw new SchemaException(at + "/type: unknown type " + t);
            }
          }
          // A union of types is standard JSON Schema, and every Kindgi schema compiler takes it
          // (Ajv's allowUnionTypes, in the TypeScript packages).
          break;
        case "properties":
        case "$defs":
          for (Map.Entry<String, Object> p : map(v, at + "/" + k).entrySet()) {
            compile(p.getValue(), at + "/" + k + "/" + escape(p.getKey()));
          }
          break;
        case "additionalProperties":
        case "propertyNames":
        case "items":
        case "not":
          compile(v, at + "/" + k);
          break;
        case "oneOf":
        case "anyOf":
        case "allOf":
          List<Object> list = list(v, at + "/" + k);
          for (int i = 0; i < list.size(); i++) {
            compile(list.get(i), at + "/" + k + "/" + i);
          }
          break;
        case "pattern":
          pattern((String) v, at);
          break;
        case "format":
          if (!Formats.KNOWN.contains(v)) {
            throw new SchemaException(at + "/format: unknown format \"" + v + "\"");
          }
          break;
        case "$ref":
          resolve((String) v, at);
          break;
        case "required":
        case "enum":
          list(v, at + "/" + k);
          break;
        default:
          break;
      }
    }
  }

  private Pattern pattern(String source, String at) {
    Pattern p = patterns.get(source);
    if (p == null) {
      try {
        p = Pattern.compile(source, Pattern.UNICODE_CHARACTER_CLASS);
      } catch (PatternSyntaxException e) {
        throw new SchemaException(at + "/pattern: not a regular expression: " + source);
      }
      patterns.put(source, p);
    }
    return p;
  }

  @SuppressWarnings("unchecked")
  private Object resolve(String ref, String at) {
    if (!ref.startsWith("#")) {
      throw new SchemaException(at + "/$ref: only local references are supported, not " + ref);
    }
    Object target = root;
    if (ref.length() > 1) {
      if (!ref.startsWith("#/")) {
        throw new SchemaException(at + "/$ref: unsupported reference " + ref);
      }
      for (String part : ref.substring(2).split("/", -1)) {
        String key = part.replace("~1", "/").replace("~0", "~");
        if (target instanceof Map && ((Map<String, Object>) target).containsKey(key)) {
          target = ((Map<String, Object>) target).get(key);
        } else if (target instanceof List && key.matches("\\d+") && Integer.parseInt(key) < ((List<Object>) target).size()) {
          target = ((List<Object>) target).get(Integer.parseInt(key));
        } else {
          throw new SchemaException(at + "/$ref: " + ref + " doesn't resolve");
        }
      }
    }
    return target;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object v, String at) {
    if (!(v instanceof Map)) {
      throw new SchemaException(at + ": must be an object");
    }
    return (Map<String, Object>) v;
  }

  @SuppressWarnings("unchecked")
  private static List<Object> list(Object v, String at) {
    if (!(v instanceof List)) {
      throw new SchemaException(at + ": must be an array");
    }
    return (List<Object>) v;
  }

  // ---------------------------------------------------------------------------------------------
  // Validating
  // ---------------------------------------------------------------------------------------------

  /**
   * @param instance a plain JSON value
   * @return every issue, Ajv-shaped ({@code instancePath}, {@code schemaPath}, {@code keyword},
   *     {@code params}, {@code message}); empty when the value is valid
   */
  public List<Map<String, Object>> issues(Object instance) {
    Issues out = new Issues(null);
    validate(root, "#", instance, "", out);
    return new ArrayList<>(out);
  }

  /**
   * The issue that best says what's wrong with a value, as Python's {@code explain} picks it:
   * through a {@code oneOf} or {@code anyOf} it follows the one alternative whose discriminator (a
   * {@code const} or {@code enum} property such as {@code kind}) the value matches, so a tool node
   * reports its own problem, not "must match exactly one schema"; when none matches, it names the
   * discriminator's allowed values.
   *
   * @param instance a plain JSON value
   * @return the issue; {@code null} when the value is valid
   */
  public @Nullable Map<String, Object> explain(Object instance) {
    Issues out = new Issues(new IdentityHashMap<>());
    validate(root, "#", instance, "", out);
    if (out.isEmpty()) {
      return null;
    }
    Map<Map<String, Object>, List<List<Map<String, Object>>>> tree = out.branches;
    Map<String, Object> error = topLevel(out, tree).get(0);
    while (tree.containsKey(error)) {
      int depth = depth(error);
      List<List<Map<String, Object>>> branches = tree.get(error);
      List<List<Map<String, Object>>> matching = new ArrayList<>();
      for (List<Map<String, Object>> errs : branches) {
        if (missedProps(errs, depth, tree).isEmpty()) {
          matching.add(errs);
        }
      }
      if (matching.size() == 1) {
        error = topLevel(matching.get(0), tree).get(0);
        continue;
      }
      if (!matching.isEmpty()) {
        break;
      }
      // Every alternative misses. The property they discriminate on (kind) is the one most of
      // them check directly; an alternative that misses only on another one (loopKind, under a
      // kind that matched) is where the value belongs.
      Map<String, Integer> counts = new LinkedHashMap<>();
      for (List<Map<String, Object>> errs : branches) {
        for (Map<String, Object> e : topLevel(errs, tree)) {
          if (isDiscriminator(e, depth)) {
            counts.merge(prop(e), 1, Integer::sum);
          }
        }
      }
      if (counts.isEmpty()) {
        break;
      }
      String prop = counts.entrySet().stream().max(Map.Entry.comparingByValue()).orElseThrow().getKey();
      List<List<Map<String, Object>>> elsewhere = new ArrayList<>();
      for (List<Map<String, Object>> errs : branches) {
        if (!missedProps(errs, depth, tree).contains(prop)) {
          elsewhere.add(errs);
        }
      }
      if (elsewhere.size() == 1) {
        List<Map<String, Object>> top = topLevel(elsewhere.get(0), tree);
        error = top.stream().filter(tree::containsKey).findFirst().orElse(top.get(0));
        continue;
      }
      List<Object> values = new ArrayList<>();
      for (List<Map<String, Object>> errs : branches) {
        allowed(errs, depth, prop, tree, values);
      }
      StringBuilder message = new StringBuilder("must be one of ");
      for (int i = 0; i < values.size(); i++) {
        message.append(i == 0 ? "" : ", ").append(Json.compactString(values.get(i)));
      }
      return issue(error.get("instancePath") + "/" + escape(prop), (String) error.get("schemaPath"), "enum",
          Map.of("allowedValues", values), message.toString());
    }
    return error;
  }

  /** The issues of a list that no combinator of the same list holds as a branch issue. */
  private static List<Map<String, Object>> topLevel(List<Map<String, Object>> errs, Map<Map<String, Object>, List<List<Map<String, Object>>>> tree) {
    Set<Map<String, Object>> nested = Collections.newSetFromMap(new IdentityHashMap<>());
    for (Map<String, Object> e : errs) {
      for (List<Map<String, Object>> branch : tree.getOrDefault(e, List.of())) {
        nested.addAll(branch);
      }
    }
    List<Map<String, Object>> out = new ArrayList<>();
    for (Map<String, Object> e : errs) {
      if (!nested.contains(e)) {
        out.add(e);
      }
    }
    return out;
  }

  private static int depth(Map<String, Object> issue) {
    String path = (String) issue.get("instancePath");
    return path.isEmpty() ? 0 : path.split("/", -1).length - 1;
  }

  private static boolean isDiscriminator(Map<String, Object> e, int depth) {
    Object keyword = e.get("keyword");
    return ("const".equals(keyword) || "enum".equals(keyword)) && depth(e) == depth + 1;
  }

  private static String prop(Map<String, Object> e) {
    String path = (String) e.get("instancePath");
    return path.substring(path.lastIndexOf('/') + 1).replace("~1", "/").replace("~0", "~");
  }

  /** The discriminating properties a branch fails on: directly, or in every alternative of a nested combinator on the same object. */
  private static Set<String> missedProps(List<Map<String, Object>> errs, int depth, Map<Map<String, Object>, List<List<Map<String, Object>>>> tree) {
    Set<String> missed = new LinkedHashSet<>();
    for (Map<String, Object> e : topLevel(errs, tree)) {
      if (isDiscriminator(e, depth)) {
        missed.add(prop(e));
      } else if (tree.containsKey(e) && depth(e) == depth) {
        List<Set<String>> nested = new ArrayList<>();
        for (List<Map<String, Object>> branch : tree.get(e)) {
          nested.add(missedProps(branch, depth, tree));
        }
        if (!nested.isEmpty() && nested.stream().noneMatch(Set::isEmpty)) {
          Set<String> common = new LinkedHashSet<>(nested.get(0));
          nested.forEach(common::retainAll);
          if (common.isEmpty()) {
            nested.forEach(common::addAll);
          }
          missed.addAll(common);
        }
      }
    }
    return missed;
  }

  @SuppressWarnings("unchecked")
  private static void allowed(List<Map<String, Object>> errs, int depth, String prop, Map<Map<String, Object>, List<List<Map<String, Object>>>> tree, List<Object> values) {
    for (Map<String, Object> e : topLevel(errs, tree)) {
      if (isDiscriminator(e, depth) && prop(e).equals(prop)) {
        Map<String, Object> params = (Map<String, Object>) e.get("params");
        List<Object> found = "enum".equals(e.get("keyword")) ? (List<Object>) params.get("allowedValues") : Collections.singletonList(params.get("allowedValue"));
        for (Object v : found) {
          if (values.stream().noneMatch(x -> jsonEquals(x, v))) {
            values.add(v);
          }
        }
      } else if (tree.containsKey(e)) {
        for (List<Map<String, Object>> branch : tree.get(e)) {
          allowed(branch, depth, prop, tree, values);
        }
      }
    }
  }

  /** Issues, and (when explaining) each failed combinator's issues by alternative. */
  private static final class Issues extends ArrayList<Map<String, Object>> {
    private static final long serialVersionUID = 1L;
    final transient @Nullable Map<Map<String, Object>, List<List<Map<String, Object>>>> branches;

    Issues(@Nullable Map<Map<String, Object>, List<List<Map<String, Object>>>> branches) {
      this.branches = branches;
    }

    Issues child() {
      return new Issues(branches);
    }
  }

  /**
   * @param instance a plain JSON value
   * @return whether it's valid
   */
  public boolean valid(Object instance) {
    return issues(instance).isEmpty();
  }

  @SuppressWarnings("unchecked")
  private void validate(Object node, String schemaPath, Object value, String instancePath, List<Map<String, Object>> out) {
    if (node instanceof Boolean) {
      if (!(Boolean) node) {
        out.add(issue(instancePath, schemaPath, "false schema", Map.of(), "boolean schema is false"));
      }
      return;
    }
    Map<String, Object> s = (Map<String, Object>) node;
    if (s.containsKey("$ref")) {
      String ref = (String) s.get("$ref");
      validate(resolve(ref, schemaPath), ref, value, instancePath, out);
    }
    if (s.containsKey("type") && !typeMatches(s.get("type"), value)) {
      Object type = s.get("type");
      String text = type instanceof List ? String.join(",", (List<String>) type) : (String) type;
      out.add(issue(instancePath, schemaPath + "/type", "type", Map.of("type", type), "must be " + text));
      // The type's own keywords don't apply to it; the others (enum, const, the combinators) do.
    }
    if (s.containsKey("enum")) {
      List<Object> allowed = (List<Object>) s.get("enum");
      if (allowed.stream().noneMatch(a -> jsonEquals(a, value))) {
        out.add(issue(instancePath, schemaPath + "/enum", "enum", Map.of("allowedValues", allowed), "must be equal to one of the allowed values"));
      }
    }
    if (s.containsKey("const") && !jsonEquals(s.get("const"), value)) {
      Map<String, Object> params = new LinkedHashMap<>();
      params.put("allowedValue", s.get("const"));
      out.add(issue(instancePath, schemaPath + "/const", "const", params, "must be equal to constant"));
    }
    if (value instanceof String) {
      strings(s, schemaPath, (String) value, instancePath, out);
    } else if (isNumber(value)) {
      numbers(s, schemaPath, (Number) value, instancePath, out);
    } else if (value instanceof Map) {
      objects(s, schemaPath, (Map<String, Object>) value, instancePath, out);
    } else if (value instanceof List) {
      arrays(s, schemaPath, (List<Object>) value, instancePath, out);
    }
    combinators(s, schemaPath, value, instancePath, out);
  }

  private void strings(Map<String, Object> s, String schemaPath, String value, String instancePath, List<Map<String, Object>> out) {
    int length = value.codePointCount(0, value.length());
    if (s.containsKey("maxLength") && length > intOf(s.get("maxLength"))) {
      out.add(issue(instancePath, schemaPath + "/maxLength", "maxLength", Map.of("limit", s.get("maxLength")), "must NOT have more than " + s.get("maxLength") + " characters"));
    }
    if (s.containsKey("minLength") && length < intOf(s.get("minLength"))) {
      out.add(issue(instancePath, schemaPath + "/minLength", "minLength", Map.of("limit", s.get("minLength")), "must NOT have fewer than " + s.get("minLength") + " characters"));
    }
    if (s.containsKey("pattern") && !pattern((String) s.get("pattern"), schemaPath).matcher(value).find()) {
      out.add(issue(instancePath, schemaPath + "/pattern", "pattern", Map.of("pattern", s.get("pattern")), "must match pattern \"" + s.get("pattern") + "\""));
    }
    if (s.containsKey("format") && !Formats.accepts((String) s.get("format"), value)) {
      out.add(issue(instancePath, schemaPath + "/format", "format", Map.of("format", s.get("format")), "must match format \"" + s.get("format") + "\""));
    }
  }

  private void numbers(Map<String, Object> s, String schemaPath, Number value, String instancePath, List<Map<String, Object>> out) {
    BigDecimal v = decimal(value);
    compare(s, "maximum", "<=", v.compareTo(decimalOf(s, "maximum")) <= 0, schemaPath, instancePath, out);
    compare(s, "minimum", ">=", v.compareTo(decimalOf(s, "minimum")) >= 0, schemaPath, instancePath, out);
    compare(s, "exclusiveMaximum", "<", v.compareTo(decimalOf(s, "exclusiveMaximum")) < 0, schemaPath, instancePath, out);
    compare(s, "exclusiveMinimum", ">", v.compareTo(decimalOf(s, "exclusiveMinimum")) > 0, schemaPath, instancePath, out);
    if (s.containsKey("multipleOf")) {
      BigDecimal m = decimal((Number) s.get("multipleOf"));
      if (v.remainder(m).signum() != 0) {
        out.add(issue(instancePath, schemaPath + "/multipleOf", "multipleOf", Map.of("multipleOf", s.get("multipleOf")), "must be multiple of " + js(s.get("multipleOf"))));
      }
    }
  }

  private void compare(Map<String, Object> s, String keyword, String op, boolean ok, String schemaPath, String instancePath, List<Map<String, Object>> out) {
    if (s.containsKey(keyword) && !ok) {
      Map<String, Object> params = new LinkedHashMap<>();
      params.put("comparison", op);
      params.put("limit", s.get(keyword));
      out.add(issue(instancePath, schemaPath + "/" + keyword, keyword, params, "must be " + op + " " + js(s.get(keyword))));
    }
  }

  private static BigDecimal decimalOf(Map<String, Object> s, String keyword) {
    Object v = s.get(keyword);
    return v instanceof Number ? decimal((Number) v) : BigDecimal.ZERO;
  }

  @SuppressWarnings("unchecked")
  private void objects(Map<String, Object> s, String schemaPath, Map<String, Object> value, String instancePath, List<Map<String, Object>> out) {
    if (s.containsKey("maxProperties") && value.size() > intOf(s.get("maxProperties"))) {
      out.add(issue(instancePath, schemaPath + "/maxProperties", "maxProperties", Map.of("limit", s.get("maxProperties")), "must NOT have more than " + s.get("maxProperties") + " properties"));
    }
    if (s.containsKey("minProperties") && value.size() < intOf(s.get("minProperties"))) {
      out.add(issue(instancePath, schemaPath + "/minProperties", "minProperties", Map.of("limit", s.get("minProperties")), "must NOT have fewer than " + s.get("minProperties") + " properties"));
    }
    if (s.containsKey("required")) {
      for (Object name : (List<Object>) s.get("required")) {
        if (!value.containsKey((String) name)) {
          out.add(issue(instancePath, schemaPath + "/required", "required", Map.of("missingProperty", name), "must have required property '" + name + "'"));
        }
      }
    }
    Map<String, Object> properties = s.containsKey("properties") ? (Map<String, Object>) s.get("properties") : Map.of();
    if (s.containsKey("additionalProperties")) {
      Object ap = s.get("additionalProperties");
      for (Map.Entry<String, Object> e : value.entrySet()) {
        if (properties.containsKey(e.getKey())) {
          continue;
        }
        if (Boolean.FALSE.equals(ap)) {
          out.add(issue(instancePath, schemaPath + "/additionalProperties", "additionalProperties", Map.of("additionalProperty", e.getKey()), "must NOT have additional properties"));
        } else if (ap instanceof Map) {
          validate(ap, schemaPath + "/additionalProperties", e.getValue(), instancePath + "/" + escape(e.getKey()), out);
        }
      }
    }
    for (Map.Entry<String, Object> p : properties.entrySet()) {
      if (value.containsKey(p.getKey())) {
        validate(p.getValue(), schemaPath + "/properties/" + escape(p.getKey()), value.get(p.getKey()), instancePath + "/" + escape(p.getKey()), out);
      }
    }
    if (s.containsKey("propertyNames")) {
      for (String name : value.keySet()) {
        List<Map<String, Object>> inner = new ArrayList<>();
        validate(s.get("propertyNames"), schemaPath + "/propertyNames", name, instancePath, inner);
        if (!inner.isEmpty()) {
          for (Map<String, Object> i : inner) {
            Map<String, Object> withName = new LinkedHashMap<>(i);
            withName.put("propertyName", name);
            out.add(withName);
          }
          Map<String, Object> issue = issue(instancePath, schemaPath + "/propertyNames", "propertyNames", Map.of("propertyName", name), "property name must be valid");
          out.add(issue);
        }
      }
    }
  }

  private void arrays(Map<String, Object> s, String schemaPath, List<Object> value, String instancePath, List<Map<String, Object>> out) {
    if (s.containsKey("maxItems") && value.size() > intOf(s.get("maxItems"))) {
      out.add(issue(instancePath, schemaPath + "/maxItems", "maxItems", Map.of("limit", s.get("maxItems")), "must NOT have more than " + s.get("maxItems") + " items"));
    }
    if (s.containsKey("minItems") && value.size() < intOf(s.get("minItems"))) {
      out.add(issue(instancePath, schemaPath + "/minItems", "minItems", Map.of("limit", s.get("minItems")), "must NOT have fewer than " + s.get("minItems") + " items"));
    }
    if (Boolean.TRUE.equals(s.get("uniqueItems")) && value.size() > 1) {
      int[] pair = duplicate(s.get("items"), value);
      if (pair != null) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("i", pair[0]);
        params.put("j", pair[1]);
        out.add(issue(instancePath, schemaPath + "/uniqueItems", "uniqueItems", params, "must NOT have duplicate items (items ## " + pair[1] + " and " + pair[0] + " are identical)"));
      }
    }
    if (s.containsKey("items")) {
      for (int i = 0; i < value.size(); i++) {
        validate(s.get("items"), schemaPath + "/items", value.get(i), instancePath + "/" + i, out);
      }
    }
  }

  /**
   * The duplicate pair Ajv reports, {i, j}, as Ajv finds it: when the items' schema declares only
   * scalar types, scanning from the end and remembering each value's index (j is the later one);
   * otherwise comparing every pair from the end (i is the later one).
   */
  @SuppressWarnings("unchecked")
  private static int[] duplicate(Object itemSchema, List<Object> value) {
    List<Object> types = new ArrayList<>();
    if (itemSchema instanceof Map && ((Map<String, Object>) itemSchema).containsKey("type")) {
      Object t = ((Map<String, Object>) itemSchema).get("type");
      types.addAll(t instanceof List ? (List<Object>) t : List.of(t));
    }
    boolean scalar = !types.isEmpty() && !types.contains("object") && !types.contains("array");
    if (scalar) {
      Map<String, Integer> indices = new HashMap<>();
      for (int i = value.size() - 1; i >= 0; i--) {
        Object item = value.get(i);
        if (!typeMatches(types, item)) {
          continue;
        }
        String key = item == null ? "null" : item instanceof Number ? CanonicalJson.number((Number) item) : item.toString();
        if (types.size() > 1 && item instanceof String) {
          key = key + "_";
        }
        Integer j = indices.get(key);
        if (j != null) {
          return new int[] {i, j};
        }
        indices.put(key, i);
      }
      return null;
    }
    for (int i = value.size() - 1; i >= 0; i--) {
      for (int j = i - 1; j >= 0; j--) {
        if (jsonEquals(value.get(i), value.get(j))) {
          return new int[] {i, j};
        }
      }
    }
    return null;
  }

  @SuppressWarnings("unchecked")
  private void combinators(Map<String, Object> s, String schemaPath, Object value, String instancePath, List<Map<String, Object>> out) {
    if (s.containsKey("not")) {
      List<Map<String, Object>> inner = new ArrayList<>();
      validate(s.get("not"), schemaPath + "/not", value, instancePath, inner);
      if (inner.isEmpty()) {
        out.add(issue(instancePath, schemaPath + "/not", "not", Map.of(), "must NOT be valid"));
      }
    }
    if (s.containsKey("anyOf")) {
      List<Object> branches = (List<Object>) s.get("anyOf");
      List<Map<String, Object>> collected = new ArrayList<>();
      List<List<Map<String, Object>>> groups = new ArrayList<>();
      boolean any = false;
      for (int i = 0; i < branches.size(); i++) {
        Issues inner = child(out);
        validate(branches.get(i), schemaPath + "/anyOf/" + i, value, instancePath, inner);
        if (inner.isEmpty()) {
          any = true;
          break;
        }
        collected.addAll(inner);
        groups.add(inner);
      }
      if (!any) {
        out.addAll(collected);
        Map<String, Object> issue = issue(instancePath, schemaPath + "/anyOf", "anyOf", Map.of(), "must match a schema in anyOf");
        out.add(issue);
        record(out, issue, groups);
      }
    }
    if (s.containsKey("oneOf")) {
      List<Object> branches = (List<Object>) s.get("oneOf");
      List<Map<String, Object>> collected = new ArrayList<>();
      List<List<Map<String, Object>>> groups = new ArrayList<>();
      List<Integer> passing = new ArrayList<>();
      for (int i = 0; i < branches.size(); i++) {
        Issues inner = child(out);
        validate(branches.get(i), schemaPath + "/oneOf/" + i, value, instancePath, inner);
        if (inner.isEmpty()) {
          passing.add(i);
        } else {
          collected.addAll(inner);
          groups.add(inner);
        }
      }
      if (passing.size() != 1) {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("passingSchemas", passing.isEmpty() ? null : passing);
        if (passing.isEmpty()) {
          out.addAll(collected);
        }
        Map<String, Object> issue = issue(instancePath, schemaPath + "/oneOf", "oneOf", params, "must match exactly one schema in oneOf");
        out.add(issue);
        if (passing.isEmpty()) {
          record(out, issue, groups);
        }
      }
    }
    if (s.containsKey("allOf")) {
      List<Object> branches = (List<Object>) s.get("allOf");
      for (int i = 0; i < branches.size(); i++) {
        validate(branches.get(i), schemaPath + "/allOf/" + i, value, instancePath, out);
      }
    }
  }

  private static Issues child(List<Map<String, Object>> out) {
    return out instanceof Issues ? ((Issues) out).child() : new Issues(null);
  }

  private static void record(List<Map<String, Object>> out, Map<String, Object> issue, List<List<Map<String, Object>>> groups) {
    if (out instanceof Issues && ((Issues) out).branches != null) {
      ((Issues) out).branches.put(issue, groups);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Values
  // ---------------------------------------------------------------------------------------------

  @SuppressWarnings("unchecked")
  private static boolean typeMatches(Object type, Object value) {
    for (Object t : type instanceof List ? (List<Object>) type : List.of(type)) {
      if (isType((String) t, value)) {
        return true;
      }
    }
    return false;
  }

  private static boolean isType(String type, Object value) {
    switch (type) {
      case "null":
        return value == null;
      case "boolean":
        return value instanceof Boolean;
      case "object":
        return value instanceof Map;
      case "array":
        return value instanceof List;
      case "string":
        return value instanceof String;
      case "number":
        return isNumber(value);
      case "integer":
        return isNumber(value) && isIntegral((Number) value);
      default:
        return false;
    }
  }

  static boolean isNumber(Object value) {
    return value instanceof Number;
  }

  private static boolean isIntegral(Number n) {
    BigDecimal d = decimal(n);
    return d.signum() == 0 || d.stripTrailingZeros().scale() <= 0;
  }

  static BigDecimal decimal(Number n) {
    if (n instanceof BigDecimal) {
      return (BigDecimal) n;
    }
    if (n instanceof Double || n instanceof Float) {
      return new BigDecimal(n.toString());
    }
    return new BigDecimal(n.toString());
  }

  private static int intOf(Object v) {
    return ((Number) v).intValue();
  }

  /** Equality of JSON values: numbers by value ({@code 1} equals {@code 1.0}), maps unordered. */
  @SuppressWarnings("unchecked")
  static boolean jsonEquals(Object a, Object b) {
    if (a == null || b == null) {
      return a == b;
    }
    if (a instanceof Number && b instanceof Number) {
      return decimal((Number) a).compareTo(decimal((Number) b)) == 0;
    }
    if (a instanceof Map && b instanceof Map) {
      Map<String, Object> ma = (Map<String, Object>) a;
      Map<String, Object> mb = (Map<String, Object>) b;
      if (ma.size() != mb.size()) {
        return false;
      }
      for (Map.Entry<String, Object> e : ma.entrySet()) {
        if (!mb.containsKey(e.getKey()) || !jsonEquals(e.getValue(), mb.get(e.getKey()))) {
          return false;
        }
      }
      return true;
    }
    if (a instanceof List && b instanceof List) {
      List<Object> la = (List<Object>) a;
      List<Object> lb = (List<Object>) b;
      if (la.size() != lb.size()) {
        return false;
      }
      for (int i = 0; i < la.size(); i++) {
        if (!jsonEquals(la.get(i), lb.get(i))) {
          return false;
        }
      }
      return true;
    }
    return a.equals(b);
  }

  private static String js(Object number) {
    return CanonicalJson.number((Number) number);
  }

  static String escape(String key) {
    return key.replace("~", "~0").replace("/", "~1");
  }

  private static Map<String, Object> issue(String instancePath, String schemaPath, String keyword, Map<String, Object> params, String message) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("instancePath", instancePath);
    m.put("schemaPath", schemaPath);
    m.put("keyword", keyword);
    m.put("params", params);
    m.put("message", message);
    return m;
  }
}
