// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.spi;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Constructor;
import java.lang.reflect.Executable;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Member;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * The SPI a JVM language layer implements names no binding library's types: nothing in a public
 * signature of {@code com.kindgi.pack.spi} is Jackson's ({@code com.fasterxml}), so kindgi-pack can
 * change how it binds without breaking a layer. Every class compiled into the package is checked.
 */
class SpiSurfaceTest {
  private static final String FORBIDDEN = "com.fasterxml.";

  /** Every class compiled into the SPI package, from kindgi-pack's own classes. */
  private static List<Class<?>> spiClasses() throws URISyntaxException, Exception {
    Path classes = Path.of(SchemaTypeAdapter.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    Path dir = classes.resolve("com/kindgi/pack/spi");
    List<Class<?>> found = new ArrayList<>();
    try (Stream<Path> files = Files.list(dir)) {
      for (Path f : files.filter(p -> p.toString().endsWith(".class")).sorted().toList()) {
        String name = "com.kindgi.pack.spi." + f.getFileName().toString().replace(".class", "");
        found.add(Class.forName(name, false, SpiSurfaceTest.class.getClassLoader()));
      }
    }
    return found;
  }

  /** The type and every type it mentions: arguments, bounds, components. */
  private static void mentions(Type type, Set<Type> seen, List<String> out) {
    if (!seen.add(type)) {
      return;
    }
    if (type instanceof Class<?> c) {
      out.add(c.isArray() ? c.getComponentType().getName() : c.getName());
      if (c.isArray()) {
        mentions(c.getComponentType(), seen, out);
      }
    } else if (type instanceof ParameterizedType p) {
      mentions(p.getRawType(), seen, out);
      for (Type a : p.getActualTypeArguments()) {
        mentions(a, seen, out);
      }
    } else if (type instanceof WildcardType w) {
      Stream.concat(Stream.of(w.getUpperBounds()), Stream.of(w.getLowerBounds())).forEach(b -> mentions(b, seen, out));
    } else if (type instanceof TypeVariable<?> v) {
      for (Type b : v.getBounds()) {
        mentions(b, seen, out);
      }
    } else if (type instanceof GenericArrayType g) {
      mentions(g.getGenericComponentType(), seen, out);
    }
  }

  private static boolean visible(Member m) {
    return Modifier.isPublic(m.getModifiers()) || Modifier.isProtected(m.getModifiers());
  }

  /** What each public signature in the class mentions, as "where: type". */
  private static List<String> surface(Class<?> c) {
    List<String> out = new ArrayList<>();
    List<Type> types = new ArrayList<>();
    if (c.getGenericSuperclass() != null) {
      types.add(c.getGenericSuperclass());
    }
    types.addAll(List.of(c.getGenericInterfaces()));
    for (Method m : c.getDeclaredMethods()) {
      if (visible(m) && !m.isSynthetic()) {
        types.add(m.getGenericReturnType());
        addSignature(m, types);
      }
    }
    for (Constructor<?> k : c.getDeclaredConstructors()) {
      if (visible(k)) {
        addSignature(k, types);
      }
    }
    for (Field f : c.getDeclaredFields()) {
      if (visible(f)) {
        types.add(f.getGenericType());
      }
    }
    for (Type t : types) {
      List<String> names = new ArrayList<>();
      mentions(t, new java.util.HashSet<>(), names);
      names.forEach(n -> out.add(c.getSimpleName() + ": " + n));
    }
    return out;
  }

  private static void addSignature(Executable e, List<Type> types) {
    types.addAll(List.of(e.getGenericParameterTypes()));
    types.addAll(List.of(e.getGenericExceptionTypes()));
    for (TypeVariable<?> v : e.getTypeParameters()) {
      types.add(v);
    }
  }

  @Test
  void theSpiNamesNoJacksonType() throws Exception {
    List<Class<?>> classes = spiClasses();
    assertThat(classes).extracting(Class::getSimpleName)
        .contains("SchemaTypeAdapter", "SchemaType", "SchemaProperty");
    List<String> surface = classes.stream().flatMap(c -> surface(c).stream()).toList();
    // The walk sees the SPI's own types, so an empty list would mean it saw nothing.
    assertThat(surface).contains("SchemaTypeAdapter: com.kindgi.pack.spi.SchemaType");
    assertThat(surface).filteredOn(s -> s.contains(FORBIDDEN)).isEmpty();
  }
}
