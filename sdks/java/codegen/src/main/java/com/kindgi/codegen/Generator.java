// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import com.palantir.javapoet.JavaFile;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import tools.jackson.databind.json.JsonMapper;

/**
 * Generates the Java client from the Kindgi API's OpenAPI document: the models ({@code
 * com.kindgi.client.models}), the resources ({@code com.kindgi.client.resources}), the operation
 * table and the clients' generated bases.
 */
public final class Generator {
  private Generator() {}

  /** What a generation wrote. */
  public record Result(int files, int written, int deleted, int operations, int types) {}

  /**
   * Generates into {@code outDir}, writing only the files whose content changed and deleting the
   * ones no longer generated, so an unchanged document leaves the sources untouched.
   *
   * @param openapi the API document
   * @param outDir the generated-sources root
   * @return what was written
   */
  public static Result generate(Path openapi, Path outDir, Target target) {
    Generated generated = sources(read(openapi));
    Map<String, String> files = new java.util.TreeMap<>();
    generated.files().forEach((path, content) -> {
      if (target.includes(path)) {
        files.put(path, content);
      }
    });
    int[] counts = write(files, outDir);
    return new Result(files.size(), counts[0], counts[1], generated.operations(), generated.types());
  }

  /** Which artifact the sources are for. */
  public enum Target {
    /** {@code kindgi-models}: the models package. */
    MODELS,
    /** {@code kindgi-client}: everything else (resources, operations, the codec). */
    CLIENT,
    /** Everything: for a look at the whole output. */
    ALL;

    boolean includes(String path) {
      boolean model = path.startsWith(ModelPlanner.MODELS.replace('.', '/') + "/");
      return this == ALL || (this == MODELS) == model;
    }
  }

  /** Every generated file (its path under the sources root → its content), and what's in them. */
  record Generated(Map<String, String> files, int operations, int types) {}

  @SuppressWarnings("unchecked")
  static Map<String, Object> read(Path openapi) {
    Map<String, Object> document = JsonMapper.builder().build().readValue(openapi.toFile(), Map.class);
    Object version = document.get("openapi");
    if (!(version instanceof String) || !((String) version).startsWith("3.1.")) {
      throw new GenerationException(openapi + ": only OpenAPI 3.1 documents are supported, not " + version);
    }
    return document;
  }

  static Generated sources(Map<String, Object> document) {
    ModelPlanner models = new ModelPlanner(document);
    OperationPlanner operations = new OperationPlanner(document, models);
    models.planComponents();
    operations.plan();
    models.drain();
    List<JavaFile> files = new ArrayList<>(new ModelWriter(models).files());
    files.addAll(new ResourceWriter(operations, models).files());
    files.addAll(new MixInWriter(models).files());
    Map<String, String> out = new java.util.TreeMap<>();
    for (JavaFile f : files) {
      String path = f.packageName().replace('.', '/') + "/" + f.typeSpec().name() + ".java";
      if (out.put(path, f.toString()) != null) {
        throw new GenerationException("two generated types write " + path);
      }
    }
    return new Generated(out, operations.ops.size(), models.index.size());
  }

  /** Writes what changed and deletes what's gone: {written, deleted}. */
  static int[] write(Map<String, String> sources, Path outDir) {
    try {
      Files.createDirectories(outDir);
      Set<Path> keep = new HashSet<>();
      int written = 0;
      for (Map.Entry<String, String> e : sources.entrySet()) {
        Path target = outDir.resolve(e.getKey());
        keep.add(target);
        byte[] bytes = e.getValue().getBytes(StandardCharsets.UTF_8);
        if (Files.isRegularFile(target) && java.util.Arrays.equals(Files.readAllBytes(target), bytes)) {
          continue;
        }
        Files.createDirectories(target.getParent());
        Files.write(target, bytes);
        written++;
      }
      int deleted = 0;
      try (Stream<Path> walk = Files.walk(outDir)) {
        for (Path p : (Iterable<Path>) walk.filter(Files::isRegularFile)::iterator) {
          if (!keep.contains(p)) {
            Files.delete(p);
            deleted++;
          }
        }
      }
      return new int[] {written, deleted};
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /**
   * {@code java -cp … com.kindgi.codegen.Generator <openapi.json> <out-dir>}: generates outside a
   * Maven build.
   *
   * @param args the document and the output directory
   */
  public static void main(String[] args) {
    if (args.length < 2) {
      System.err.println("usage: Generator <openapi.json> <out-dir> [models|client|all]");
      System.exit(2);
    }
    Target target = args.length > 2 ? Target.valueOf(args[2].toUpperCase(java.util.Locale.ROOT)) : Target.ALL;
    Result r = generate(Path.of(args[0]), Path.of(args[1]), target);
    System.out.println(r);
  }
}
