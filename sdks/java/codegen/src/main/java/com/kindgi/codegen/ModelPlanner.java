// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import com.palantir.javapoet.ClassName;
import com.palantir.javapoet.ParameterizedTypeName;
import com.palantir.javapoet.TypeName;
import java.time.OffsetDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * Plans the model types from the API document's schemas: a record per object schema, a tolerant
 * enum class per string enum, and a sealed interface per union. Every component schema that
 * defines a type gets one, whether or not an operation uses it. Inline schemas get a type nested
 * in the one that uses them ({@code Run.Status}); an inline union of named schemas becomes a
 * top-level interface, shared by every property with the same variants.
 */
final class ModelPlanner {
  static final String MODELS = "com.kindgi.client.models";
  static final ClassName STRING = ClassName.get(String.class);
  static final ClassName LONG = ClassName.get(Long.class);
  static final ClassName DOUBLE = ClassName.get(Double.class);
  static final ClassName BOOLEAN = ClassName.get(Boolean.class);
  static final ClassName OBJECT = ClassName.get(Object.class);
  static final ClassName LIST = ClassName.get(List.class);
  static final ClassName MAP = ClassName.get(Map.class);

  /** What a schema is, after following `$ref`s and aliases. */
  enum Shape {
    OBJECT,
    STRING,
    SCALAR,
    NULL,
    ANY,
    ARRAY,
    MAP,
    UNION
  }

  /** An object schema's members, with `allOf` parts merged. */
  record View(Map<String, Schema> props, Set<String> required, Object additionalProperties, String description) {}

  /** How a union's variants are told apart. */
  static final class UnionPlan {
    Ir.UnionKind kind;
    Ir.UnionKind objectKind;
    String tag;
    final List<Schema> objects = new ArrayList<>();
    Schema text;
    final Map<Schema, List<String>> tags = new HashMap<>();
    final Map<Schema, List<String>> unique = new HashMap<>();
  }

  /** Where the types a schema needs are declared. */
  interface Scope {
    /** Reserves a type name in this scope. */
    ClassName nested(String simpleName);

    void add(Ir.Decl decl);

    /** The scope's own name, flattened (`Run.Step` → `RunStep`), as a prefix for top-level types. */
    String flat();
  }

  private final Map<String, Schema> components = new LinkedHashMap<>();
  /** Top-level types, in the order they're planned. */
  final Map<ClassName, Ir.Decl> decls = new LinkedHashMap<>();
  /** Every planned type, nested ones included. */
  final Map<ClassName, Ir.Decl> index = new HashMap<>();

  private final Map<String, TypeName> componentTypes = new HashMap<>();
  private final Set<String> resolvingAliases = new HashSet<>();
  private final Deque<String> pending = new ArrayDeque<>();
  private final Set<String> topNames = new HashSet<>();
  private final Map<String, ClassName> unionsBySignature = new HashMap<>();
  /** A record that's a variant of a top-level union implements it. */
  private final Map<ClassName, Set<ClassName>> implementsMap = new HashMap<>();
  /** Component → the property that tags it in a tagged union. */
  private final Map<String, String> tagFields = new HashMap<>();
  private final Scope top = new TopScope();

  ModelPlanner(Map<String, Object> document) {
    Object comps = document.get("components");
    Object schemas = comps instanceof Map ? ((Map<?, ?>) comps).get("schemas") : null;
    if (!(schemas instanceof Map)) {
      throw new GenerationException("the document has no components.schemas");
    }
    for (Map.Entry<?, ?> e : ((Map<?, ?>) schemas).entrySet()) {
      String name = (String) e.getKey();
      components.put(name, Schema.of(e.getValue(), "#/components/schemas/" + name));
    }
    for (Map.Entry<String, Schema> e : components.entrySet()) {
      if (definesClass(e.getValue())) {
        String java = javaName(e.getKey());
        if (!topNames.add(java)) {
          throw new GenerationException("two component schemas become the Java type " + java);
        }
      }
    }
    // Tagged unions first: a variant's tag property is text, even when it's an enum.
    for (Schema s : components.values()) {
      walk(s, this::noteTags);
    }
  }

  /** Every schema the operations use, for the tag scan (call before planning operations). */
  void noteOperationSchema(Schema s) {
    walk(s, this::noteTags);
  }

  Scope top() {
    return top;
  }

  /** Plans every component schema that defines a type, and everything they reference. */
  void planComponents() {
    for (Map.Entry<String, Schema> e : components.entrySet()) {
      componentType(e.getKey());
    }
    drain();
  }

  /** Plans what's still pending, then wires union variants to their interfaces. */
  void drain() {
    while (!pending.isEmpty()) {
      buildComponent(pending.removeFirst());
    }
    for (Map.Entry<ClassName, Set<ClassName>> e : implementsMap.entrySet()) {
      Ir.Decl d = index.get(e.getKey());
      if (!(d instanceof Ir.RecordDecl)) {
        throw new GenerationException(e.getKey() + " is a union variant but not an object type");
      }
      ((Ir.RecordDecl) d).interfaces.addAll(e.getValue());
    }
  }

  Schema component(String name) {
    Schema s = components.get(name);
    if (s == null) {
      throw new GenerationException("$ref to a missing schema: " + name);
    }
    return s;
  }

  static String javaName(String componentName) {
    boolean identifier =
        !componentName.isEmpty()
            && Character.isUpperCase(componentName.charAt(0))
            && componentName.chars().allMatch(c -> Character.isLetterOrDigit(c));
    return identifier ? componentName : Names.pascal(componentName);
  }

  // ---------------------------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------------------------

  TypeName componentType(String name) {
    TypeName known = componentTypes.get(name);
    if (known != null) {
      return known;
    }
    Schema s = component(name);
    if (definesClass(s)) {
      ClassName cn = ClassName.get(MODELS, javaName(name));
      componentTypes.put(name, cn);
      pending.addLast(name);
      return cn;
    }
    if (!resolvingAliases.add(name)) {
      throw new GenerationException("schema " + name + " is an alias of itself");
    }
    TypeName t = typeOf(s, top, javaName(name));
    resolvingAliases.remove(name);
    componentTypes.put(name, t);
    return t;
  }

  /** The Java type of a schema; inline types it needs are declared in {@code scope}. */
  TypeName typeOf(Schema s, Scope scope, String hint) {
    s.check();
    if (s.ref() != null) {
      return componentType(s.ref());
    }
    if (!s.variants().isEmpty()) {
      return unionType(s, scope, hint);
    }
    List<Schema> all = s.allOf();
    if (!all.isEmpty()) {
      if (all.size() == 1 && s.properties().isEmpty()) {
        return typeOf(all.get(0), scope, hint);
      }
      ClassName cn = scope.nested(hint);
      scope.add(planRecord(cn, s, null));
      return cn;
    }
    if (s.enumValues() != null) {
      if (s.type() != null && !"string".equals(s.type())) {
        throw new GenerationException(s + ": enum of type " + s.type());
      }
      ClassName cn = scope.nested(hint);
      Ir.EnumDecl e = new Ir.EnumDecl(cn, s.description(), s.enumValues());
      scope.add(e);
      return cn;
    }
    if (s.hasConst()) {
      return constType(s, s.constValue());
    }
    String type = s.type();
    if ("multiple".equals(type)) {
      for (String t : s.types()) {
        if (!Set.of("string", "number", "integer", "boolean", "null").contains(t)) {
          throw new GenerationException(s + ": unsupported type list " + s.types());
        }
      }
      return OBJECT;
    }
    if (type == null) {
      if (s.has("properties")) {
        type = "object";
      } else if (s.isAny()) {
        return OBJECT;
      } else if (s.types().contains("null")) {
        throw new GenerationException(s + ": a bare null type outside a union");
      } else {
        throw new GenerationException(s + ": a schema with no type the generator understands");
      }
    }
    switch (type) {
      case "string":
        String format = s.string("format");
        if ("uuid".equals(format)) {
          return ClassName.get(UUID.class);
        }
        if ("date-time".equals(format)) {
          return ClassName.get(OffsetDateTime.class);
        }
        if ("binary".equals(format)) {
          return com.palantir.javapoet.ArrayTypeName.of(TypeName.BYTE);
        }
        return STRING;
      case "integer":
        return LONG;
      case "number":
        return DOUBLE;
      case "boolean":
        return BOOLEAN;
      case "array":
        Schema items = s.items();
        if (items == null) {
          throw new GenerationException(s + ": an array without items");
        }
        return ParameterizedTypeName.get(LIST, typeOf(items, scope, hint + "Item"));
      case "object":
        Object ap = s.additionalProperties();
        if (!s.properties().isEmpty() || Boolean.FALSE.equals(ap)) {
          ClassName cn = scope.nested(hint);
          scope.add(planRecord(cn, s, null));
          return cn;
        }
        TypeName value = ap instanceof Schema ? typeOf((Schema) ap, scope, hint + "Value") : OBJECT;
        return ParameterizedTypeName.get(MAP, STRING, value);
      default:
        throw new GenerationException(s + ": unsupported type " + type);
    }
  }

  private TypeName constType(Schema where, Object value) {
    if (value instanceof String) {
      return STRING;
    }
    if (value instanceof Integer || value instanceof Long) {
      return LONG;
    }
    if (value instanceof Boolean) {
      return BOOLEAN;
    }
    throw new GenerationException(where + ": unsupported const " + value);
  }

  private TypeName unionType(Schema s, Scope scope, String hint) {
    List<Schema> nonNull = nonNull(s.variants());
    if (nonNull.isEmpty()) {
      throw new GenerationException(s + ": a union of only null");
    }
    if (nonNull.size() == 1) {
      return typeOf(nonNull.get(0), scope, hint);
    }
    if (nonNull.stream().allMatch(v -> shapeOf(v) == Shape.STRING)) {
      // Strings in different formats, or an enum beside free text: text (the tolerant enum class
      // when there's exactly one enum, since it keeps any other value too).
      Schema onlyEnum = null;
      int enums = 0;
      for (Schema v : nonNull) {
        if (isEnumLike(v)) {
          enums++;
          onlyEnum = v;
        }
      }
      return enums == 1 ? typeOf(onlyEnum, scope, hint) : STRING;
    }
    if (nonNull.stream().allMatch(v -> shapeOf(v) == Shape.STRING || shapeOf(v) == Shape.SCALAR)) {
      return OBJECT;
    }
    UnionPlan plan = analyze(s);
    boolean allNamed = plan.objects.stream().allMatch(o -> o.ref() != null);
    if (allNamed) {
      StringBuilder sig = new StringBuilder(plan.kind + "|" + plan.tag + "|");
      for (Schema o : plan.objects) {
        sig.append(o.ref()).append(',');
      }
      sig.append('|').append(plan.text == null ? "" : plan.text.raw.toString());
      ClassName shared = unionsBySignature.get(sig.toString());
      if (shared != null) {
        return shared;
      }
      ClassName cn = reserveTop(scope.flat() + hint);
      Ir.UnionDecl u = planUnion(cn, s, plan);
      register(u, true);
      unionsBySignature.put(sig.toString(), cn);
      return cn;
    }
    ClassName cn = scope.nested(hint);
    scope.add(planUnion(cn, s, plan));
    return cn;
  }

  private boolean isEnumLike(Schema v) {
    if (v.ref() != null) {
      Schema c = component(v.ref());
      return c.enumValues() != null || (c.ref() != null && isEnumLike(c));
    }
    return v.enumValues() != null;
  }

  // ---------------------------------------------------------------------------------------------
  // Shapes
  // ---------------------------------------------------------------------------------------------

  /** Whether the schema itself (not through a `$ref`) declares a Java type. */
  boolean definesClass(Schema s) {
    s.check();
    if (s.ref() != null) {
      return false;
    }
    if (!s.variants().isEmpty()) {
      return shapeOf(s) == Shape.UNION;
    }
    List<Schema> all = s.allOf();
    if (!all.isEmpty()) {
      return !(all.size() == 1 && s.properties().isEmpty());
    }
    if (s.enumValues() != null) {
      return true;
    }
    return shapeOf(s) == Shape.OBJECT;
  }

  Shape shapeOf(Schema s) {
    s.check();
    if (s.ref() != null) {
      return shapeOf(component(s.ref()));
    }
    if (!s.variants().isEmpty()) {
      List<Schema> nonNull = nonNull(s.variants());
      if (nonNull.isEmpty()) {
        return Shape.NULL;
      }
      if (nonNull.size() == 1) {
        return shapeOf(nonNull.get(0));
      }
      boolean strings = true;
      boolean scalars = true;
      for (Schema v : nonNull) {
        Shape sh = shapeOf(v);
        strings &= sh == Shape.STRING;
        scalars &= sh == Shape.STRING || sh == Shape.SCALAR;
      }
      return strings ? Shape.STRING : scalars ? Shape.SCALAR : Shape.UNION;
    }
    List<Schema> all = s.allOf();
    if (!all.isEmpty()) {
      return all.size() == 1 && s.properties().isEmpty() ? shapeOf(all.get(0)) : Shape.OBJECT;
    }
    if (s.enumValues() != null) {
      return Shape.STRING;
    }
    if (s.hasConst()) {
      return s.constValue() instanceof String ? Shape.STRING : Shape.SCALAR;
    }
    String type = s.type();
    if ("multiple".equals(type)) {
      return s.types().contains("object") || s.types().contains("array") ? Shape.ANY : Shape.SCALAR;
    }
    if (type == null) {
      if (s.has("properties")) {
        return Shape.OBJECT;
      }
      if (s.types().contains("null")) {
        return Shape.NULL;
      }
      return Shape.ANY;
    }
    switch (type) {
      case "string":
        return Shape.STRING;
      case "integer":
      case "number":
      case "boolean":
        return Shape.SCALAR;
      case "array":
        return Shape.ARRAY;
      case "object":
        return !s.properties().isEmpty() || Boolean.FALSE.equals(s.additionalProperties())
            ? Shape.OBJECT
            : Shape.MAP;
      default:
        throw new GenerationException(s + ": unsupported type " + type);
    }
  }

  private List<Schema> nonNull(List<Schema> variants) {
    List<Schema> out = new ArrayList<>();
    for (Schema v : variants) {
      if (shapeOf(v) != Shape.NULL) {
        out.add(v);
      }
    }
    return out;
  }

  boolean isNullable(Schema s) {
    if (s.nullableType()) {
      return true;
    }
    for (Schema v : s.variants()) {
      if (shapeOf(v) == Shape.NULL) {
        return true;
      }
    }
    return false;
  }

  View viewOf(Schema s) {
    s.check();
    if (s.ref() != null) {
      return viewOf(component(s.ref()));
    }
    Map<String, Schema> props = new LinkedHashMap<>();
    Set<String> required = new LinkedHashSet<>();
    Object ap = s.additionalProperties();
    for (Schema part : s.allOf()) {
      if (shapeOf(part) != Shape.OBJECT) {
        throw new GenerationException(part + ": allOf of something other than objects");
      }
      View v = viewOf(part);
      props.putAll(v.props());
      required.addAll(v.required());
      if (ap == null) {
        ap = v.additionalProperties();
      }
    }
    props.putAll(s.properties());
    required.addAll(s.required());
    return new View(props, required, ap, s.description());
  }

  // ---------------------------------------------------------------------------------------------
  // Unions
  // ---------------------------------------------------------------------------------------------

  /** How a union's variants are told apart; fails on any union the generator can't handle. */
  UnionPlan analyze(Schema s) {
    UnionPlan plan = new UnionPlan();
    for (Schema v : nonNull(s.variants())) {
      Shape sh = shapeOf(v);
      if (sh == Shape.OBJECT) {
        plan.objects.add(v);
      } else if (sh == Shape.STRING) {
        if (plan.text != null) {
          throw new GenerationException(s + ": a union with two text variants beside objects");
        }
        plan.text = v;
      } else {
        throw new GenerationException(
            s + ": unsupported union variant " + v + " (" + sh + "); the generator supports"
                + " objects told apart by a tag or by their properties, optionally beside one"
                + " string");
      }
    }
    if (plan.objects.isEmpty() || (plan.objects.size() == 1 && plan.text == null)) {
      throw new GenerationException(s + ": not a union of objects");
    }
    if (plan.objects.size() >= 2) {
      Object disc = s.raw.get("discriminator");
      String preferred =
          disc instanceof Map ? (String) ((Map<?, ?>) disc).get("propertyName") : null;
      String tag = findTag(plan, preferred);
      if (tag != null) {
        plan.objectKind = Ir.UnionKind.TAGGED;
        plan.tag = tag;
        checkMapping(s, disc, plan);
      } else if (deduce(plan)) {
        plan.objectKind = Ir.UnionKind.DEDUCED;
        if (preferred != null) {
          throw new GenerationException(s + ": discriminator " + preferred + " doesn't tag every variant");
        }
      } else {
        throw new GenerationException(
            s + ": can't tell this union's variants apart: no property with a fixed value per"
                + " variant, and no required property unique to each");
      }
    }
    plan.kind = plan.text != null ? Ir.UnionKind.TEXT_OR_OBJECT : plan.objectKind;
    return plan;
  }

  private String findTag(UnionPlan plan, String preferred) {
    List<View> views = new ArrayList<>();
    for (Schema o : plan.objects) {
      views.add(viewOf(o));
    }
    Set<String> common = new LinkedHashSet<>(views.get(0).props().keySet());
    for (View v : views) {
      common.retainAll(v.props().keySet());
    }
    List<String> valid = new ArrayList<>();
    for (String c : common) {
      Set<String> seen = new HashSet<>();
      boolean ok = true;
      for (View v : views) {
        List<String> values = tagValues(v.props().get(c));
        if (!v.required().contains(c) || values == null) {
          ok = false;
          break;
        }
        for (String value : values) {
          ok &= seen.add(value);
        }
      }
      if (ok) {
        valid.add(c);
      }
    }
    String chosen = null;
    if (preferred != null && valid.contains(preferred)) {
      chosen = preferred;
    } else {
      for (String p : List.of("kind", "type", "transport")) {
        if (valid.contains(p)) {
          chosen = p;
          break;
        }
      }
      if (chosen == null && !valid.isEmpty()) {
        chosen = valid.stream().sorted().findFirst().get();
      }
    }
    if (chosen != null) {
      for (int i = 0; i < plan.objects.size(); i++) {
        plan.tags.put(plan.objects.get(i), tagValues(views.get(i).props().get(chosen)));
      }
    }
    return chosen;
  }

  private void checkMapping(Schema s, Object disc, UnionPlan plan) {
    if (!(disc instanceof Map) || !(((Map<?, ?>) disc).get("mapping") instanceof Map)) {
      return;
    }
    Map<?, ?> mapping = (Map<?, ?>) ((Map<?, ?>) disc).get("mapping");
    for (Map.Entry<?, ?> e : mapping.entrySet()) {
      String ref = ((String) e.getValue()).replace("#/components/schemas/", "");
      boolean found = false;
      for (Schema o : plan.objects) {
        if (ref.equals(o.ref()) && plan.tags.get(o).contains((String) e.getKey())) {
          found = true;
        }
      }
      if (!found) {
        throw new GenerationException(s + ": discriminator mapping " + e.getKey() + " → " + ref + " disagrees with the variants' tags");
      }
    }
  }

  /** The fixed values of a tag property: its `const`, or its `enum`. */
  List<String> tagValues(Schema p) {
    if (p == null) {
      return null;
    }
    if (p.ref() != null) {
      return tagValues(component(p.ref()));
    }
    if (p.hasConst() && p.constValue() instanceof String) {
      return List.of((String) p.constValue());
    }
    return p.enumValues();
  }

  private boolean deduce(UnionPlan plan) {
    List<View> views = new ArrayList<>();
    for (Schema o : plan.objects) {
      views.add(viewOf(o));
    }
    for (int i = 0; i < views.size(); i++) {
      Set<String> unique = new LinkedHashSet<>(views.get(i).required());
      for (int j = 0; j < views.size(); j++) {
        if (j != i) {
          unique.removeAll(views.get(j).props().keySet());
        }
      }
      if (unique.isEmpty()) {
        return false;
      }
      plan.unique.put(plan.objects.get(i), new ArrayList<>(unique));
    }
    return true;
  }

  private Ir.UnionDecl planUnion(ClassName cn, Schema s, UnionPlan plan) {
    Ir.UnionDecl u = new Ir.UnionDecl(cn, s.description(), plan.kind);
    u.objectKind = plan.objectKind;
    if (plan.tag != null) {
      u.tagWire = plan.tag;
      u.tagJava = Names.camel(plan.tag);
    }
    Scope scope = new DeclScope(cn, u.nested);
    for (Schema o : plan.objects) {
      List<String> tags = plan.tags.get(o);
      List<String> unique = plan.unique.get(o);
      ClassName vt;
      if (o.ref() != null) {
        TypeName t = componentType(o.ref());
        if (!(t instanceof ClassName)) {
          throw new GenerationException(o + ": a union variant that isn't a type");
        }
        vt = (ClassName) t;
        implementsMap.computeIfAbsent(vt, k -> new LinkedHashSet<>()).add(cn);
      } else {
        String name;
        if (tags != null) {
          List<String> parts = new ArrayList<>();
          for (String t : tags) {
            parts.add(Names.pascal(t));
          }
          name = String.join("Or", parts);
        } else if (unique != null) {
          name = "With" + Names.pascal(unique.get(0));
        } else {
          View v = viewOf(o);
          name = v.required().isEmpty() ? "Fields" : "With" + Names.pascal(v.required().iterator().next());
        }
        vt = scope.nested(name);
        Ir.RecordDecl rd = planRecord(vt, o, plan.objectKind == Ir.UnionKind.TAGGED ? plan.tag : null);
        rd.interfaces.add(cn);
        scope.add(rd);
      }
      u.variants.add(new Ir.Variant(vt, tags, unique, false, null));
    }
    if (plan.text != null) {
      List<String> allowed = tagValues(plan.text);
      String name = allowed != null && allowed.size() == 1 ? Names.pascal(allowed.get(0)) : "Text";
      u.variants.add(new Ir.Variant(scope.nested(name), null, null, true, allowed));
    }
    if (plan.objectKind == Ir.UnionKind.TAGGED || plan.objectKind == Ir.UnionKind.DEDUCED) {
      u.unrecognized = scope.nested("Unrecognized");
    }
    return u;
  }

  /** A top-level sealed interface over the shapes of one response, chosen by HTTP status. */
  ClassName statusUnion(String name, String description, List<ClassName> variants) {
    ClassName cn = reserveTop(name);
    Ir.UnionDecl u = new Ir.UnionDecl(cn, description, Ir.UnionKind.BY_STATUS);
    for (ClassName v : variants) {
      if (u.variants.stream().noneMatch(x -> x.type().equals(v))) {
        u.variants.add(new Ir.Variant(v, null, null, false, null));
        implementsMap.computeIfAbsent(v, k -> new LinkedHashSet<>()).add(cn);
      }
    }
    register(u, true);
    return cn;
  }

  private void noteTags(Schema s) {
    if (s.variants().isEmpty() || shapeOf(s) != Shape.UNION) {
      return;
    }
    UnionPlan plan = analyze(s);
    if (plan.objectKind != Ir.UnionKind.TAGGED) {
      return;
    }
    for (Schema o : plan.objects) {
      if (o.ref() != null) {
        String prior = tagFields.put(o.ref(), plan.tag);
        if (prior != null && !prior.equals(plan.tag)) {
          throw new GenerationException(
              o.ref() + " is a variant of two tagged unions with different tags (" + prior + ", "
                  + plan.tag + ")");
        }
      }
    }
  }

  /** Calls {@code f} on {@code s} and every schema inside it (not following `$ref`s). */
  static void walk(Schema s, Consumer<Schema> f) {
    f.accept(s);
    for (Schema p : s.properties().values()) {
      walk(p, f);
    }
    if (s.items() != null) {
      walk(s.items(), f);
    }
    if (s.additionalProperties() instanceof Schema) {
      walk((Schema) s.additionalProperties(), f);
    }
    for (Schema v : s.variants()) {
      walk(v, f);
    }
    for (Schema v : s.allOf()) {
      walk(v, f);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------------------------

  private void buildComponent(String name) {
    ClassName cn = (ClassName) componentTypes.get(name);
    if (index.containsKey(cn)) {
      return;
    }
    Schema s = component(name);
    Ir.Decl d;
    if (s.enumValues() != null) {
      d = new Ir.EnumDecl(cn, s.description(), s.enumValues());
    } else if (!s.variants().isEmpty()) {
      d = planUnion(cn, s, analyze(s));
    } else {
      d = planRecord(cn, s, tagFields.get(name));
    }
    register(d, true);
  }

  private void register(Ir.Decl d, boolean topLevel) {
    if (topLevel) {
      decls.put(d.name(), d);
    }
    index.put(d.name(), d);
    List<Ir.Decl> nested =
        d instanceof Ir.RecordDecl
            ? ((Ir.RecordDecl) d).nested
            : d instanceof Ir.UnionDecl ? ((Ir.UnionDecl) d).nested : List.of();
    for (Ir.Decl n : nested) {
      register(n, false);
    }
  }

  Ir.RecordDecl planRecord(ClassName cn, Schema s, String tagProperty) {
    View view = viewOf(s);
    Ir.RecordDecl d = new Ir.RecordDecl(cn, view.description());
    Scope scope = new DeclScope(cn, d.nested);
    Set<String> javaNames = new HashSet<>();
    for (Map.Entry<String, Schema> e : view.props().entrySet()) {
      String prop = e.getKey();
      Schema ps = e.getValue();
      Ir.Field f = new Ir.Field();
      f.wire = prop;
      f.java = Names.member(prop);
      if (f.java.equals("additionalProperties")) {
        throw new GenerationException(s + ": property \"" + prop + "\" clashes with the kept unknown properties");
      }
      if (!javaNames.add(f.java)) {
        throw new GenerationException(s + ": two properties become the Java name " + f.java);
      }
      f.required = view.required().contains(prop);
      f.nullable = isNullable(ps);
      f.description = ps.description();
      if (prop.equals(tagProperty)) {
        f.type = STRING;
        f.tagValues = tagValues(ps);
        if (f.tagValues == null) {
          throw new GenerationException(s + ": tag property " + prop + " has no fixed values");
        }
      } else if (ps.hasConst() && ps.enumValues() == null) {
        f.type = constType(ps, ps.constValue());
        f.constValue = ps.constValue();
      } else {
        f.type = typeOf(ps, scope, Names.pascal(prop));
      }
      f.triState = f.nullable && !f.required;
      f.constraints = constraintsOf(ps);
      f.defaultValue = ps.raw.get("default");
      d.fields.add(f);
    }
    Object ap = view.additionalProperties();
    if (!view.props().isEmpty() && (Boolean.TRUE.equals(ap) || ap instanceof Schema)) {
      d.open = true;
      d.openValueType = ap instanceof Schema ? typeOf((Schema) ap, scope, "AdditionalProperty") : OBJECT;
    }
    return d;
  }

  /** One query or header parameter of an operation, as a member of its parameters record. */
  record ParamSpec(String wire, String java, Schema schema, boolean required, String description, TypeName fixedType) {}

  /** A record of an operation's query and header parameters, with a builder, in {@code cn}'s package. */
  Ir.RecordDecl planParams(ClassName cn, String description, List<ParamSpec> params) {
    if (!topNames.add(cn.simpleName())) {
      throw new GenerationException("the generated type " + cn.simpleName() + " collides with another type");
    }
    Ir.RecordDecl d = new Ir.RecordDecl(cn, description);
    Scope scope = new DeclScope(cn, d.nested);
    for (ParamSpec p : params) {
      Ir.Field f = new Ir.Field();
      f.wire = p.wire();
      f.java = p.java();
      f.required = p.required();
      f.description = p.description();
      f.type = p.fixedType() != null ? p.fixedType() : typeOf(p.schema(), scope, Names.pascal(p.java()));
      f.constraints = p.fixedType() != null ? Ir.Constraints.NONE : constraintsOf(p.schema());
      d.fields.add(f);
    }
    register(d, true);
    return d;
  }

  /** The checks a value carries: its own keywords, and those of an alias it refers to. */
  Ir.Constraints constraintsOf(Schema s) {
    if (s.ref() != null) {
      Schema c = component(s.ref());
      return definesClass(c) ? Ir.Constraints.NONE : constraintsOf(c);
    }
    List<Schema> nonNull = nonNull(s.variants());
    if (!s.variants().isEmpty()) {
      return nonNull.size() == 1 ? constraintsOf(nonNull.get(0)) : Ir.Constraints.NONE;
    }
    if (definesClass(s)) {
      return Ir.Constraints.NONE;
    }
    Ir.Constraints items = s.items() == null ? null : constraintsOf(s.items());
    Object names = s.raw.get("propertyNames");
    Ir.Constraints keys = names == null ? null : constraintsOf(Schema.of(names, s.where + ".propertyNames").check());
    Object ap = s.additionalProperties();
    Ir.Constraints values = ap instanceof Schema ? constraintsOf((Schema) ap) : null;
    Ir.Constraints c =
        new Ir.Constraints(
            s.integer("minLength"),
            s.integer("maxLength"),
            s.string("pattern"),
            s.decimal("minimum"),
            s.decimal("maximum"),
            s.decimal("exclusiveMinimum"),
            s.integer("minItems"),
            s.integer("maxItems"),
            s.flag("uniqueItems"),
            s.integer("minProperties"),
            s.integer("maxProperties"),
            items,
            keys,
            values);
    return c.isEmpty() ? Ir.Constraints.NONE : c;
  }

  // ---------------------------------------------------------------------------------------------
  // Scopes
  // ---------------------------------------------------------------------------------------------

  ClassName reserveTop(String simpleName) {
    if (!topNames.add(simpleName)) {
      throw new GenerationException("the generated type " + simpleName + " collides with another type");
    }
    return ClassName.get(MODELS, simpleName);
  }

  private final class TopScope implements Scope {
    @Override
    public ClassName nested(String simpleName) {
      return reserveTop(simpleName);
    }

    @Override
    public void add(Ir.Decl decl) {
      register(decl, true);
    }

    @Override
    public String flat() {
      return "";
    }
  }

  /** Types nested in a record or an interface. */
  static final class DeclScope implements Scope {
    private final ClassName owner;
    private final List<Ir.Decl> nested;
    private final Set<String> used = new HashSet<>();

    DeclScope(ClassName owner, List<Ir.Decl> nested) {
      this.owner = owner;
      this.nested = nested;
      used.add("Builder");
      used.add("Codec");
    }

    @Override
    public ClassName nested(String simpleName) {
      String name = simpleName;
      // A nested type can't share a name with any type that encloses it.
      if (owner.simpleNames().contains(name)) {
        name = name + "Value";
      }
      if (!used.add(name)) {
        throw new GenerationException(owner + ": two nested types named " + name);
      }
      return owner.nestedClass(name);
    }

    @Override
    public void add(Ir.Decl decl) {
      nested.add(Objects.requireNonNull(decl));
    }

    @Override
    public String flat() {
      return String.join("", owner.simpleNames());
    }
  }
}
