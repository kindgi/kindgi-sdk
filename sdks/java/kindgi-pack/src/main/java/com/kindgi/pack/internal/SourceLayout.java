// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * How a JVM language's source file names the class its primitives live in, and where a pack of that
 * language keeps its sources by default.
 *
 * <ul>
 *   <li>Java: {@code src/main/java/com/acme/tools/Greet.java} is the class {@code
 *       com.acme.tools.Greet}; its primitives are static fields.
 *   <li>Scala: {@code src/main/scala/com/acme/tools/Greet.scala} is the object {@code Greet}, the
 *       class {@code com.acme.tools.Greet$}; its primitives are the object's vals, read through its
 *       {@code MODULE$}.
 * </ul>
 *
 * A file's extension picks its layout, so a Scala pack may hold Java files and the other way round;
 * a pack's {@code language} picks only the default discovery globs.
 */
public enum SourceLayout {
  /** {@code src/main/java/…/Name.java} → {@code …Name}. */
  JAVA("java", "src/main/java/", ".java", ""),
  /** {@code src/main/scala/…/Name.scala} → the object {@code …Name$}. */
  SCALA("scala", "src/main/scala/", ".scala", "$");

  private final String language;
  private final String root;
  private final String extension;
  private final String classSuffix;

  SourceLayout(String language, String root, String extension, String classSuffix) {
    this.language = language;
    this.root = root;
    this.extension = extension;
    this.classSuffix = classSuffix;
  }

  /** @return the {@code language} a pack of this layout names in its config */
  public String language() {
    return language;
  }

  /** @return the source root, with its trailing slash ({@code src/main/java/}) */
  public String root() {
    return root;
  }

  /** @return the source files' extension ({@code .java}) */
  public String extension() {
    return extension;
  }

  /**
   * @param rel a pack-relative path, {@code /}-separated
   * @return the layout whose root and extension the path has; {@code null} for any other path
   */
  public static @Nullable SourceLayout of(String rel) {
    for (SourceLayout layout : values()) {
      if (rel.startsWith(layout.root) && rel.endsWith(layout.extension) && rel.length() > layout.root.length() + layout.extension.length()) {
        return layout;
      }
    }
    return null;
  }

  /**
   * @param language a config's {@code language}
   * @return its layout; {@code null} when no layout has that language
   */
  public static @Nullable SourceLayout forLanguage(@Nullable Object language) {
    for (SourceLayout layout : values()) {
      if (layout.language.equals(language)) {
        return layout;
      }
    }
    return null;
  }

  /** @return every layout's language, in order ({@code java}, {@code scala}) */
  public static List<String> languages() {
    return java.util.Arrays.stream(values()).map(SourceLayout::language).toList();
  }

  /**
   * @param rel a path of this layout ({@link #of} returned it)
   * @return the name of the class that holds the file's primitives ({@code com.acme.tools.Greet},
   *     or {@code com.acme.tools.Greet$} for a Scala object)
   */
  public String className(String rel) {
    return sourceName(rel) + classSuffix;
  }

  /**
   * @param rel a path of this layout
   * @return the name the file's source declares ({@code com.acme.tools.Greet}), without the
   *     object's {@code $}
   */
  public String sourceName(String rel) {
    return rel.substring(root.length(), rel.length() - extension.length()).replace('/', '.');
  }

  /** @return the path's segments under the root ({@code com}, {@code acme}, {@code tools}, {@code Greet.java}) */
  public String[] segments(String rel) {
    return rel.substring(root.length()).split("/");
  }

  /** @return the discovery globs a pack of this layout gets by default, by folder */
  public Map<String, String> defaultDiscovery() {
    Map<String, String> d = new LinkedHashMap<>();
    for (String folder : List.of("tools", "guardrails", "agents", "flows")) {
      d.put(folder, root + "**/" + folder + "/**/*" + extension);
    }
    return Collections.unmodifiableMap(d);
  }
}
