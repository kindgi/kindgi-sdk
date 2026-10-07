// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.databind.BeanDescription;
import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.introspect.AnnotatedMember;
import com.fasterxml.jackson.databind.introspect.BeanPropertyDefinition;
import com.kindgi.pack.spi.SchemaTypeAdapter;
import java.lang.annotation.Annotation;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.URI;
import java.net.URL;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.ServiceLoader;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A tool's input or output type as a JSON Schema (Draft 2020-12), in the subset {@link
 * SchemaValidator} checks.
 *
 * <ul>
 *   <li>A record (or a Jackson bean) is an object with its properties, by their Jackson names. A
 *       property is required unless it's {@code @Nullable} (JSpecify or any {@code Nullable}) or an
 *       {@code Optional}; a nullable one also allows {@code null}. Unknown properties are refused
 *       ({@code additionalProperties: false}) unless the type says {@code
 *       @JsonIgnoreProperties(ignoreUnknown = true)}.
 *   <li>Jakarta (or javax) Validation constraints become the matching keywords: {@code @Size},
 *       {@code @Min}, {@code @Max}, {@code @DecimalMin}, {@code @DecimalMax}, {@code @Positive},
 *       {@code @PositiveOrZero}, {@code @Negative}, {@code @NegativeOrZero}, {@code @Pattern},
 *       {@code @NotBlank}, {@code @NotEmpty}, {@code @NotNull}, {@code @Email}.
 *   <li>{@code @JsonPropertyDescription} and {@code @JsonClassDescription} become {@code
 *       description}; {@code @JsonProperty(defaultValue = …)} becomes {@code default}.
 *   <li>A sealed interface or abstract class with {@code @JsonTypeInfo(use = NAME)} and {@code
 *       @JsonSubTypes} is a {@code oneOf}, each variant's tag a {@code const}.
 * </ul>
 *
 * A type it can't express (a recursive one, a map with non-string keys) fails, saying which.
 *
 * <p>A JVM language layer teaches it its own types ({@link SchemaTypeAdapter}, found through
 * {@code ServiceLoader}): their schemas, their optional wrappers, their default values.
 */
public final class SchemaDeriver {
  private final ObjectMapper mapper = Json.binding();
  private final Deque<Class<?>> stack = new ArrayDeque<>();

  private SchemaDeriver() {}

  /** The adapters on the classpath, found once. */
  private static volatile @Nullable List<SchemaTypeAdapter> adapters;

  static List<SchemaTypeAdapter> adapters() {
    List<SchemaTypeAdapter> found = adapters;
    if (found == null) {
      List<SchemaTypeAdapter> loaded = new ArrayList<>();
      ServiceLoader.load(SchemaTypeAdapter.class).forEach(loaded::add);
      found = List.copyOf(loaded);
      adapters = found;
    }
    return found;
  }

  /** The type an optional wrapper (a Java {@code Optional}, or an adapter's) wraps; {@code null} when it isn't one. */
  private static @Nullable JavaType optionalContent(JavaType t) {
    if (Optional.class.isAssignableFrom(t.getRawClass())) {
      return t.containedTypeOrUnknown(0);
    }
    for (SchemaTypeAdapter adapter : adapters()) {
      JavaType inner = adapter.optionalOf(t);
      if (inner != null) {
        return inner;
      }
    }
    return null;
  }

  /** The type can't be described as a schema. */
  public static final class DerivationException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    DerivationException(String message) {
      super(message);
    }
  }

  /**
   * @param type a tool's input or output type (a record, usually)
   * @return its schema
   * @throws DerivationException when the type can't be expressed
   */
  public static Map<String, Object> schema(Type type) {
    SchemaDeriver d = new SchemaDeriver();
    return d.of(d.mapper.getTypeFactory().constructType(type), List.of(), type.getTypeName());
  }

  private Map<String, Object> of(JavaType t, List<Annotation> annotations, String where) {
    Class<?> raw = t.getRawClass();
    Map<String, Object> s = new LinkedHashMap<>();
    JavaType optional = optionalContent(t);
    if (optional != null) {
      return of(optional, annotations, where);
    }
    for (SchemaTypeAdapter adapter : adapters()) {
      Map<String, Object> adapted = adapter.schema(t, inner -> of(inner, List.of(), where + "[]"));
      if (adapted != null) {
        Map<String, Object> copy = new LinkedHashMap<>(adapted);
        constraints(copy, annotations, where);
        return copy;
      }
    }
    if (raw == String.class || CharSequence.class.isAssignableFrom(raw) || raw == char.class || raw == Character.class) {
      s.put("type", "string");
    } else if (raw == boolean.class || raw == Boolean.class) {
      s.put("type", "boolean");
    } else if (raw == int.class || raw == long.class || raw == short.class || raw == byte.class
        || raw == Integer.class || raw == Long.class || raw == Short.class || raw == Byte.class || raw == BigInteger.class) {
      s.put("type", "integer");
    } else if (raw == double.class || raw == float.class || raw == Double.class || raw == Float.class
        || raw == BigDecimal.class || raw == Number.class) {
      s.put("type", "number");
    } else if (raw.isEnum()) {
      s.put("type", "string");
      List<Object> values = new ArrayList<>();
      for (Object constant : raw.getEnumConstants()) {
        values.add(mapper.convertValue(constant, Object.class));
      }
      s.put("enum", values);
    } else if (raw == UUID.class) {
      s.put("type", "string");
      s.put("format", "uuid");
    } else if (raw == OffsetDateTime.class || raw == ZonedDateTime.class || raw == Instant.class) {
      s.put("type", "string");
      s.put("format", "date-time");
    } else if (raw == LocalDate.class) {
      s.put("type", "string");
      s.put("format", "date");
    } else if (raw == URI.class || raw == URL.class) {
      s.put("type", "string");
      s.put("format", "uri");
    } else if (t.isArrayType() || Collection.class.isAssignableFrom(raw)) {
      s.put("type", "array");
      s.put("items", of(t.getContentType(), List.of(), where + "[]"));
      if (Set.class.isAssignableFrom(raw)) {
        s.put("uniqueItems", true);
      }
    } else if (Map.class.isAssignableFrom(raw)) {
      JavaType key = t.getKeyType();
      if (key != null && key.getRawClass() != String.class && key.getRawClass() != Object.class) {
        throw new DerivationException(where + ": a map's keys must be strings, not " + key.getRawClass().getName());
      }
      s.put("type", "object");
      JavaType value = t.getContentType();
      if (value != null && value.getRawClass() != Object.class) {
        s.put("additionalProperties", of(value, List.of(), where + "{}"));
      }
    } else if (raw == Object.class || JsonNode.class.isAssignableFrom(raw)) {
      // Any JSON value.
    } else if (raw.isAnnotationPresent(JsonTypeInfo.class) && raw.isAnnotationPresent(JsonSubTypes.class)) {
      return union(raw, where);
    } else if (!raw.isPrimitive() && !raw.isInterface() && !Modifier.isAbstract(raw.getModifiers())) {
      return object(t, where);
    } else {
      throw new DerivationException(where + ": no JSON Schema for " + raw.getName());
    }
    constraints(s, annotations, where);
    return s;
  }

  private Map<String, Object> object(JavaType t, String where) {
    Class<?> raw = t.getRawClass();
    if (stack.contains(raw)) {
      throw new DerivationException(where + ": " + raw.getName() + " refers to itself; recursive types aren't supported");
    }
    stack.push(raw);
    try {
      BeanDescription bean = mapper.getDeserializationConfig().introspect(t);
      Map<String, Object> s = new LinkedHashMap<>();
      s.put("type", "object");
      JsonClassDescription classDescription = raw.getAnnotation(JsonClassDescription.class);
      if (classDescription != null && !classDescription.value().isEmpty()) {
        s.put("description", classDescription.value());
      }
      Map<String, Object> properties = new LinkedHashMap<>();
      List<Object> required = new ArrayList<>();
      for (BeanPropertyDefinition p : bean.findProperties()) {
        if (!p.couldDeserialize() && !p.couldSerialize()) {
          continue;
        }
        List<Annotation> annotations = annotations(raw, p);
        boolean nullable = nullable(raw, p, annotations) || optionalContent(p.getPrimaryType()) != null;
        Map<String, Object> ps = of(p.getPrimaryType(), annotations, where + "." + p.getName());
        String description = p.getMetadata().getDescription();
        if (description != null && !description.isEmpty()) {
          ps.put("description", description);
        }
        String defaultValue = p.getMetadata().getDefaultValue();
        if (defaultValue != null && !defaultValue.isEmpty()) {
          ps.put("default", defaultOf(defaultValue, ps, where + "." + p.getName()));
        } else {
          for (SchemaTypeAdapter adapter : adapters()) {
            Optional<Object> adapted = adapter.defaultValue(raw, p.getName());
            if (adapted.isPresent()) {
              ps.put("default", Json.unbind(adapted.get()));
              break;
            }
          }
        }
        boolean notNull = annotations.stream().anyMatch(a -> Set.of("NotNull", "NotBlank", "NotEmpty").contains(a.annotationType().getSimpleName()));
        if (nullable && !notNull) {
          ps = nullableOf(ps);
        }
        properties.put(p.getName(), ps);
        if (p.isRequired() || notNull || (!nullable && !ps.containsKey("default"))) {
          required.add(p.getName());
        }
      }
      s.put("properties", properties);
      if (!required.isEmpty()) {
        s.put("required", required);
      }
      JsonIgnoreProperties ignore = raw.getAnnotation(JsonIgnoreProperties.class);
      boolean open = (ignore != null && ignore.ignoreUnknown()) || bean.findAnySetterAccessor() != null;
      if (!open) {
        s.put("additionalProperties", false);
      }
      return s;
    } finally {
      stack.pop();
    }
  }

  private Map<String, Object> union(Class<?> raw, String where) {
    JsonTypeInfo info = raw.getAnnotation(JsonTypeInfo.class);
    if (info.use() != JsonTypeInfo.Id.NAME) {
      throw new DerivationException(where + ": a union needs @JsonTypeInfo(use = NAME), not " + info.use());
    }
    String tag = info.property().isEmpty() ? "@type" : info.property();
    List<Object> variants = new ArrayList<>();
    for (JsonSubTypes.Type sub : raw.getAnnotation(JsonSubTypes.class).value()) {
      List<String> names = new ArrayList<>(List.of(sub.names()));
      if (!sub.name().isEmpty()) {
        names.add(0, sub.name());
      }
      if (names.isEmpty()) {
        throw new DerivationException(where + ": @JsonSubTypes.Type " + sub.value().getName() + " needs a name");
      }
      Map<String, Object> variant = object(mapper.getTypeFactory().constructType(sub.value()), where + "<" + sub.value().getSimpleName() + ">");
      @SuppressWarnings("unchecked")
      Map<String, Object> properties = (Map<String, Object>) variant.get("properties");
      Map<String, Object> tagSchema = new LinkedHashMap<>();
      if (names.size() == 1) {
        tagSchema.put("const", names.get(0));
      } else {
        tagSchema.put("type", "string");
        tagSchema.put("enum", new ArrayList<Object>(names));
      }
      Map<String, Object> withTag = new LinkedHashMap<>();
      withTag.put(tag, tagSchema);
      properties.forEach(withTag::putIfAbsent);
      variant.put("properties", withTag);
      @SuppressWarnings("unchecked")
      List<Object> required = new ArrayList<>((List<Object>) variant.getOrDefault("required", List.of()));
      if (!required.contains(tag)) {
        required.add(0, tag);
      }
      variant.put("required", required);
      variants.add(variant);
    }
    Map<String, Object> s = new LinkedHashMap<>();
    s.put("oneOf", variants);
    return s;
  }

  /** The annotations of a property: on its record component, field, accessor and parameter. */
  private static List<Annotation> annotations(Class<?> owner, BeanPropertyDefinition p) {
    List<Annotation> out = new ArrayList<>();
    for (AnnotatedMember m : new AnnotatedMember[] {p.getField(), p.getGetter(), p.getConstructorParameter(), p.getSetter()}) {
      if (m != null && m.getAnnotated() != null) {
        out.addAll(List.of(m.getAnnotated().getAnnotations()));
      }
    }
    if (p.getConstructorParameter() != null) {
      for (Annotation a : p.getConstructorParameter().getOwner().getAnnotated() instanceof java.lang.reflect.Executable
          ? ((java.lang.reflect.Executable) p.getConstructorParameter().getOwner().getAnnotated()).getParameterAnnotations()[p.getConstructorParameter().getIndex()]
          : new Annotation[0]) {
        out.add(a);
      }
    }
    if (owner.isRecord()) {
      for (RecordComponent rc : owner.getRecordComponents()) {
        if (rc.getName().equals(p.getInternalName())) {
          out.addAll(List.of(rc.getAnnotations()));
          out.addAll(List.of(rc.getAnnotatedType().getAnnotations()));
        }
      }
    }
    return out;
  }

  private static boolean nullable(Class<?> owner, BeanPropertyDefinition p, List<Annotation> annotations) {
    if (annotations.stream().anyMatch(a -> a.annotationType().getSimpleName().equals("Nullable"))) {
      return true;
    }
    Field f = p.getField() == null ? null : p.getField().getAnnotated();
    return f != null && List.of(f.getAnnotatedType().getAnnotations()).stream().anyMatch(a -> a.annotationType().getSimpleName().equals("Nullable"));
  }

  private static Map<String, Object> nullableOf(Map<String, Object> s) {
    Object type = s.get("type");
    if (type instanceof String && !s.containsKey("enum") && !s.containsKey("const")) {
      Map<String, Object> out = new LinkedHashMap<>(s);
      out.put("type", List.of(type, "null"));
      return out;
    }
    Map<String, Object> out = new LinkedHashMap<>();
    Map<String, Object> nullType = new LinkedHashMap<>();
    nullType.put("type", "null");
    out.put("oneOf", List.of(s, nullType));
    return out;
  }

  private static Object defaultOf(String text, Map<String, Object> schema, String where) {
    Object type = schema.get("type");
    try {
      if ("integer".equals(type)) {
        return Long.parseLong(text);
      }
      if ("number".equals(type)) {
        return Double.parseDouble(text);
      }
      if ("boolean".equals(type)) {
        if (!text.equals("true") && !text.equals("false")) {
          throw new NumberFormatException(text);
        }
        return Boolean.parseBoolean(text);
      }
    } catch (NumberFormatException e) {
      throw new DerivationException(where + ": default \"" + text + "\" isn't a " + type);
    }
    return text;
  }

  /** Validation constraints, by their simple names (Jakarta's or javax's). */
  private static void constraints(Map<String, Object> s, List<Annotation> annotations, String where) {
    Object type = s.get("type");
    for (Annotation a : annotations) {
      String name = a.annotationType().getSimpleName();
      String pkg = a.annotationType().getPackageName();
      if (!pkg.endsWith("validation.constraints")) {
        continue;
      }
      switch (name) {
        case "Size":
          long min = ((Number) attr(a, "min")).longValue();
          long max = ((Number) attr(a, "max")).longValue();
          String[] keys = "string".equals(type) ? new String[] {"minLength", "maxLength"}
              : "array".equals(type) ? new String[] {"minItems", "maxItems"}
              : new String[] {"minProperties", "maxProperties"};
          if (min > 0) {
            s.put(keys[0], min);
          }
          if (max < Integer.MAX_VALUE) {
            s.put(keys[1], max);
          }
          break;
        case "NotEmpty":
          s.put("string".equals(type) ? "minLength" : "array".equals(type) ? "minItems" : "minProperties", 1);
          break;
        case "NotBlank":
          s.put("minLength", 1);
          s.put("pattern", "\\S");
          break;
        case "Min":
          s.put("minimum", ((Number) attr(a, "value")).longValue());
          break;
        case "Max":
          s.put("maximum", ((Number) attr(a, "value")).longValue());
          break;
        case "DecimalMin":
          s.put(Boolean.TRUE.equals(attr(a, "inclusive")) ? "minimum" : "exclusiveMinimum", decimal((String) attr(a, "value"), where));
          break;
        case "DecimalMax":
          s.put(Boolean.TRUE.equals(attr(a, "inclusive")) ? "maximum" : "exclusiveMaximum", decimal((String) attr(a, "value"), where));
          break;
        case "Positive":
          s.put("exclusiveMinimum", 0);
          break;
        case "PositiveOrZero":
          s.put("minimum", 0);
          break;
        case "Negative":
          s.put("exclusiveMaximum", 0);
          break;
        case "NegativeOrZero":
          s.put("maximum", 0);
          break;
        case "Pattern":
          s.put("pattern", attr(a, "regexp"));
          break;
        case "Email":
          s.put("format", "email");
          break;
        default:
          break;
      }
    }
  }

  private static Number decimal(String text, String where) {
    try {
      BigDecimal d = new BigDecimal(text);
      return d.scale() <= 0 ? (Number) d.longValueExact() : (Number) d.doubleValue();
    } catch (NumberFormatException | ArithmeticException e) {
      throw new DerivationException(where + ": not a number: " + text);
    }
  }

  private static Object attr(Annotation a, String name) {
    try {
      return a.annotationType().getMethod(name).invoke(a);
    } catch (ReflectiveOperationException e) {
      throw new DerivationException("@" + a.annotationType().getSimpleName() + " has no " + name);
    }
  }
}
