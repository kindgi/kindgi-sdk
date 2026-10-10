// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Discovery globs: which files under a pack root are primitives. Same syntax and semantics as the
 * TypeScript {@code discovery.ts} and Python's {@code discovery.py}: {@code **} (any depth,
 * including none), {@code *} (within one segment), {@code ?} (one character), {@code {a,b}}
 * alternation. Each pattern is walked from its static prefix only.
 */
public final class Discovery {
  private static final Pattern GLOB_CHARS = Pattern.compile("[*?{\\[]");

  /** Tests sit next to primitives and are never primitives. */
  static final Pattern TEST_FILE = Pattern.compile("(?:^|/)src/test/|(?:Test|Tests|IT)\\.(?:java|scala)$");

  /** Never walked: dot directories and installed packages anywhere; build output at the root. */
  private static final Set<String> SKIP_DIRS = Set.of("node_modules");

  private static final Set<String> SKIP_ROOT_DIRS = Set.of("target", "build", "out", "dist");

  private Discovery() {}

  /**
   * @param pattern a discovery glob
   * @return the regex that matches it in full
   */
  public static Pattern globToRegex(String pattern) {
    StringBuilder out = new StringBuilder("^");
    int i = 0;
    while (i < pattern.length()) {
      char c = pattern.charAt(i);
      if (c == '*' && i + 1 < pattern.length() && pattern.charAt(i + 1) == '*') {
        if (i + 2 < pattern.length() && pattern.charAt(i + 2) == '/') {
          out.append("(?:.*/)?");
          i += 3;
        } else {
          out.append(".*");
          i += 2;
        }
        continue;
      }
      int close = c == '{' ? pattern.indexOf('}', i) : -1;
      if (c == '*') {
        out.append("[^/]*");
      } else if (c == '?') {
        out.append("[^/]");
      } else if (close != -1) {
        List<String> options = new ArrayList<>();
        for (String o : pattern.substring(i + 1, close).split(",", -1)) {
          options.add(Pattern.quote(o));
        }
        out.append("(?:").append(String.join("|", options)).append(')');
        i = close + 1;
        continue;
      } else {
        out.append(Pattern.quote(String.valueOf(c)));
      }
      i++;
    }
    return Pattern.compile(out.append('$').toString());
  }

  /**
   * @param pattern a discovery glob
   * @return the directories before its first glob segment ({@code src/main/java})
   */
  public static String staticPrefix(String pattern) {
    String[] segments = pattern.split("/", -1);
    int firstGlob = -1;
    for (int i = 0; i < segments.length; i++) {
      if (GLOB_CHARS.matcher(segments[i]).find()) {
        firstGlob = i;
        break;
      }
    }
    int end = firstGlob == -1 ? segments.length - 1 : firstGlob;
    List<String> dirs = new ArrayList<>();
    for (int i = 0; i < end; i++) {
      if (!segments[i].isEmpty() && !segments[i].equals(".")) {
        dirs.add(segments[i]);
      }
    }
    return String.join("/", dirs);
  }

  /**
   * @param root the pack's root
   * @param pattern a discovery glob
   * @return the {@code /}-separated paths under the root that match, sorted, tests excluded
   */
  public static List<String> discover(Path root, String pattern) {
    Pattern regex = globToRegex(pattern);
    String prefix = staticPrefix(pattern);
    Path start = prefix.isEmpty() ? root : root.resolve(prefix);
    List<String> matches = new ArrayList<>();
    if (!Files.isDirectory(start)) {
      return matches;
    }
    walk(root, start, matches, regex);
    return matches;
  }

  private static void walk(Path root, Path dir, List<String> out, Pattern regex) {
    List<Path> children;
    try (Stream<Path> list = Files.list(dir)) {
      children = new ArrayList<>(list.toList());
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    children.sort(null);
    for (Path child : children) {
      String name = child.getFileName().toString();
      if (name.startsWith(".")) {
        continue;
      }
      if (Files.isDirectory(child)) {
        if (SKIP_DIRS.contains(name) || (dir.equals(root) && SKIP_ROOT_DIRS.contains(name))) {
          continue;
        }
        walk(root, child, out, regex);
        continue;
      }
      String rel = relative(root, child);
      if (regex.matcher(rel).matches() && !TEST_FILE.matcher(rel).find()) {
        out.add(rel);
      }
    }
  }

  private static String relative(Path root, Path file) {
    List<String> parts = new ArrayList<>();
    for (Path p : root.relativize(file)) {
      parts.add(p.toString());
    }
    return String.join("/", parts);
  }
}
