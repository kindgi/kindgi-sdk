// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.Json;
import java.io.PrintStream;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code java -cp … com.kindgi.pack.Main index …} and {@code … serve …}, with the pack's classes
 * and their dependencies on the classpath.
 */
public final class Main {
  static final String USAGE = String.join("\n",
      "usage:",
      "  java -cp <classpath> com.kindgi.pack.Main index --pack-dir <path> [--config <kindgi.config.json>]",
      "      [--output <index.json>] [--artifact-version <str>] [--published-at <iso>] [--json]",
      "  kindgi-pack-java -cp <classpath> com.kindgi.pack.Main serve [--index <path>] [--module-root <dir>] [--host <address>]",
      "  java -cp <classpath> com.kindgi.pack.Main launcher > kindgi-pack-java   (writes the launcher script)");

  private Main() {}

  /**
   * @param args the command and its arguments
   */
  public static void main(String[] args) {
    int code = run(List.of(args), System.out, System.err);
    if (code != 0 || (args.length > 0 && !args[0].equals("serve"))) {
      System.out.flush();
      System.exit(code);
    }
  }

  static int run(List<String> args, PrintStream out, PrintStream err) {
    if (args.isEmpty() || args.get(0).equals("-h") || args.get(0).equals("--help")) {
      out.println(USAGE);
      return args.isEmpty() ? 2 : 0;
    }
    String command = args.get(0);
    List<String> rest = args.subList(1, args.size());
    switch (command) {
      case "index":
        return index(rest, out, err);
      case "serve":
        return Serve.main(rest, err);
      case "launcher":
        return launcher(out, err);
      default:
        err.println("kindgi-pack: unknown command " + command + "\n" + USAGE);
        return 2;
    }
  }

  private static int index(List<String> argv, PrintStream out, PrintStream err) {
    Set<String> flags = Set.of("--pack-dir", "--config", "--output", "--artifact-version", "--published-at");
    Map<String, String> options = new LinkedHashMap<>();
    boolean json = false;
    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);
      if (arg.equals("--json")) {
        json = true;
      } else if (arg.equals("-h") || arg.equals("--help")) {
        out.println(USAGE);
        return 0;
      } else if (flags.contains(arg) && i + 1 < argv.size()) {
        options.put(arg, argv.get(++i));
      } else {
        err.println("kindgi-pack index: unexpected argument " + arg + "\n" + USAGE);
        return 2;
      }
    }
    if (!options.containsKey("--pack-dir")) {
      err.println("kindgi-pack index: --pack-dir is required\n" + USAGE);
      return 2;
    }
    Map<String, Object> outcome = Indexer.run(
        Path.of(options.get("--pack-dir")),
        options.containsKey("--config") ? Path.of(options.get("--config")) : null,
        options.containsKey("--output") ? Path.of(options.get("--output")) : null,
        options.get("--artifact-version"),
        options.get("--published-at"),
        Thread.currentThread().getContextClassLoader());
    if (json) {
      // One line, the shape `kindgi dev` reads from its indexer child.
      out.println(Json.compactString(outcome));
      return "ok".equals(outcome.get("kind")) ? 0 : 1;
    }
    if ("err".equals(outcome.get("kind"))) {
      Map<?, ?> error = (Map<?, ?>) outcome.get("error");
      err.println("kindgi-pack index: " + error.get("code") + ": " + error.get("message"));
      return 1;
    }
    out.println(pretty(outcome.get("value")));
    return 0;
  }

  /** The launcher script ({@code kindgi-pack-java}), as this jar ships it. */
  private static int launcher(PrintStream out, PrintStream err) {
    try (java.io.InputStream in = Main.class.getResourceAsStream("kindgi-pack-java")) {
      if (in == null) {
        err.println("kindgi-pack: the launcher is missing from this jar");
        return 1;
      }
      out.write(in.readAllBytes());
      out.flush();
      return 0;
    } catch (java.io.IOException e) {
      err.println("kindgi-pack: " + e.getMessage());
      return 1;
    }
  }

  private static String pretty(Object value) {
    try {
      return Json.mapper().writerWithDefaultPrettyPrinter().writeValueAsString(value);
    } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
      return String.valueOf(value);
    }
  }
}
