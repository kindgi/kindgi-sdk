// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.JsonValue;
import com.kindgi.client.models.Checks;
import com.kindgi.client.models.TestRunBaseline;
import com.kindgi.client.models.AgentPinScope;
import com.kindgi.client.models.Model;
import com.kindgi.client.models.OpenEnum;
import com.kindgi.client.models.Run;
import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.net.URISyntaxException;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Every generated enum and union reads a value a newer runtime sends that this client doesn't know
 * yet, through the client's own codec: an enum as {@code UNRECOGNIZED}, keeping the text, and a
 * tagged or deduced union as its {@code Unrecognized} variant, keeping the object. The Python
 * client is held to the same by its generator's open check, apart from the field Python code
 * tells a method's answers apart by ({@code secrets.rotate}'s {@code kind}), which stays closed
 * there.
 *
 * <p>Each of them is refused before it's sent: checked as a request body ({@link Checks#sending()}),
 * it fails, while a builder's checks ({@code new Checks()}) keep it.
 */
class OpenValuesTest {
  private static final String UNKNOWN = "kindgi-test-unknown";

  /** Every class the models module generates, nested ones included. */
  private static List<Class<?>> models() throws IOException, URISyntaxException, ClassNotFoundException {
    Path location = Path.of(Model.class.getProtectionDomain().getCodeSource().getLocation().toURI());
    String pkg = Model.class.getPackageName().replace('.', '/');
    List<Class<?>> found = new ArrayList<>();
    if (Files.isDirectory(location)) {
      collect(location.resolve(pkg), found);
    } else {
      try (FileSystem jar = FileSystems.newFileSystem(location)) {
        collect(jar.getPath(pkg), found);
      }
    }
    return found;
  }

  private static void collect(Path dir, List<Class<?>> found) throws IOException, ClassNotFoundException {
    List<String> names;
    try (Stream<Path> files = Files.list(dir)) {
      names = files.map(f -> f.getFileName().toString()).filter(n -> n.endsWith(".class")).sorted().toList();
    }
    for (String name : names) {
      found.add(Class.forName(Model.class.getPackageName() + "." + name.substring(0, name.length() - ".class".length())));
    }
  }

  /** {@code type}'s nested class {@code simpleName}, if it has one. */
  private static Class<?> nested(Class<?> type, String simpleName) {
    for (Class<?> inner : type.getDeclaredClasses()) {
      if (inner.getSimpleName().equals(simpleName)) {
        return inner;
      }
    }
    return null;
  }

  /** The name of an enum class's nested enum of known values: {@code Known} in a class named or nested in {@code Value}. */
  private static String knownValues(Class<?> type) {
    for (Class<?> c = type; c != null; c = c.getEnclosingClass()) {
      if (c.getSimpleName().equals("Value")) {
        return "Known";
      }
    }
    return "Value";
  }

  @Test
  void everyEnumReadsAValueItDoesntKnowAndKeepsIt() throws Exception {
    List<String> enums = new ArrayList<>();
    for (Class<?> type : models()) {
      Class<?> value = nested(type, knownValues(type));
      if (value == null || !value.isEnum()) {
        continue;
      }
      Object read = KindgiJson.read("\"" + UNKNOWN + "\"", type);
      assertThat(type.getMethod("value").invoke(read)).as(type.getName()).hasToString("UNRECOGNIZED");
      assertThat(type.getMethod("asString").invoke(read)).as(type.getName()).isEqualTo(UNKNOWN);
      assertThat(KindgiJson.write(read)).as(type.getName()).isEqualTo("\"" + UNKNOWN + "\"");
      enums.add(type.getName());
    }
    assertThat(enums).contains(Run.Status.class.getName()).hasSizeGreaterThan(100);
  }

  @Test
  void everyTaggedOrDeducedUnionReadsAVariantItDoesntKnowAndKeepsIt() throws Exception {
    List<String> unions = new ArrayList<>();
    for (Class<?> type : models()) {
      JsonTypeInfo info = type.getAnnotation(JsonTypeInfo.class);
      if (info == null || !type.isInterface()) {
        continue;
      }
      Class<?> unrecognized = nested(type, "Unrecognized");
      assertThat(info.defaultImpl()).as(type.getName()).isEqualTo(unrecognized);
      String body =
          info.use() == JsonTypeInfo.Id.NAME
              ? "{\"" + info.property() + "\":\"" + UNKNOWN + "\",\"kindgiTestExtra\":1}"
              : "{\"kindgiTestExtra\":1}";
      Object read = KindgiJson.read(body, type);
      assertThat(read).as(type.getName()).isInstanceOf(unrecognized);
      assertThat(KindgiJson.write(read)).as(type.getName()).isEqualTo(body);
      if (info.use() == JsonTypeInfo.Id.NAME) {
        Method tag = tagOf(type);
        assertThat(tag.invoke(read)).as(type.getName()).isEqualTo(UNKNOWN);
      }
      unions.add(type.getName());
    }
    assertThat(unions).contains(AgentPinScope.class.getName()).hasSizeGreaterThan(10);
  }

  /** A tagged union's own method for its tag: the one abstract method it declares that reads text. */
  private static Method tagOf(Class<?> union) {
    List<Method> tags = new ArrayList<>();
    for (Method m : union.getDeclaredMethods()) {
      if (java.lang.reflect.Modifier.isAbstract(m.getModifiers()) && m.getParameterCount() == 0 && m.getReturnType() == String.class) {
        tags.add(m);
      }
    }
    assertThat(tags).as(union.getName()).hasSize(1);
    return tags.get(0);
  }

  /** The problems {@code value} has, checked as a request body or not. */
  private static List<String> problems(Object value, boolean sending) {
    Checks checks = sending ? Checks.sending() : new Checks();
    checks.nested("", value);
    return checks.violations();
  }

  @Test
  void everyEnumKnowsItsValuesAndRefusesAnotherOnlyOnSend() throws Exception {
    int enums = 0;
    for (Class<?> type : models()) {
      Class<?> value = nested(type, knownValues(type));
      if (value == null || !value.isEnum()) {
        continue;
      }
      assertThat(OpenEnum.class).as(type.getName()).isAssignableFrom(type);
      List<String> known = new ArrayList<>();
      for (Object constant : value.getEnumConstants()) {
        if (!constant.toString().equals("UNRECOGNIZED")) {
          OpenEnum k = (OpenEnum) type.getField(constant.toString()).get(null);
          assertThat(problems(k, true)).as(type.getName() + " " + k.asString()).isEmpty();
          known.add(k.asString());
        }
      }
      OpenEnum read = (OpenEnum) KindgiJson.read("\"" + UNKNOWN + "\"", type);
      assertThat(read.knownValues()).as(type.getName()).isEqualTo(known);
      assertThat(problems(read, false)).as(type.getName()).isEmpty();
      assertThat(problems(read, true)).as(type.getName()).containsExactly("(value): must be one of " + String.join(", ", known));
      enums++;
    }
    assertThat(enums).isGreaterThan(100);
  }

  @Test
  void everyUnionVariantItDoesntKnowIsRefusedOnlyOnSend() throws Exception {
    List<String> unions = new ArrayList<>();
    for (Class<?> type : models()) {
      Class<?> unrecognized = type.isInterface() ? nested(type, "Unrecognized") : null;
      if (unrecognized == null) {
        continue;
      }
      String tag = null;
      for (RecordComponent c : unrecognized.getRecordComponents()) {
        if (!c.getName().equals("properties")) {
          tag = c.getAccessor().getAnnotation(JsonProperty.class).value();
        }
      }
      String body = tag != null ? "{\"" + tag + "\":\"" + UNKNOWN + "\",\"kindgiTestExtra\":1}" : "{\"kindgiTestExtra\":1}";
      Object read = KindgiJson.read(body, type);
      assertThat(read).as(type.getName()).isInstanceOf(unrecognized);
      assertThat(problems(read, false)).as(type.getName()).isEmpty();
      if (tag != null) {
        assertThat(problems(read, true)).as(type.getName()).singleElement().asString().startsWith(tag + ": must be one of ");
      } else {
        assertThat(problems(read, true)).as(type.getName()).containsExactly("(value): a variant this client doesn't know can't be sent");
      }
      unions.add(type.getSimpleName());
    }
    assertThat(unions).contains(AgentPinScope.class.getSimpleName(), TestRunBaseline.class.getSimpleName()).hasSizeGreaterThan(10);
  }

  @Test
  void aUnionsTextItDoesntKnowIsRefusedOnlyOnSend() throws Exception {
    List<String> refused = new ArrayList<>();
    for (Class<?> type : models()) {
      if (!type.isInterface() || !Model.class.isAssignableFrom(type)) {
        continue;
      }
      for (Class<?> variant : type.getDeclaredClasses()) {
        RecordComponent[] components = variant.getRecordComponents();
        // The text variant: one text, written as it is.
        if (components == null || components.length != 1 || components[0].getAccessor().getAnnotation(JsonValue.class) == null) {
          continue;
        }
        Object read = KindgiJson.read("\"" + UNKNOWN + "\"", type);
        assertThat(read).as(type.getName()).isInstanceOf(variant);
        assertThat(problems(read, false)).as(type.getName()).isEmpty();
        if (!problems(read, true).isEmpty()) {
          assertThat(problems(read, true)).as(type.getName()).singleElement().asString().startsWith("(value): must be one of ");
          refused.add(type.getSimpleName());
        }
      }
    }
    assertThat(refused).containsExactly(TestRunBaseline.class.getSimpleName());
  }
}
