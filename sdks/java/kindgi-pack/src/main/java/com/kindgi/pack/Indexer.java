// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import com.kindgi.pack.internal.CanonicalJson;
import com.kindgi.pack.internal.Discovery;
import com.kindgi.pack.internal.Json;
import com.kindgi.pack.internal.PackConfig;
import com.kindgi.pack.internal.SchemaDeriver;
import com.kindgi.pack.internal.SchemaValidator;
import com.kindgi.pack.internal.SourceLayout;
import com.kindgi.pack.internal.Specs;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * The indexer: a Java pack's {@code index.json}.
 *
 * <pre>
 * java -cp &lt;the pack's classpath&gt; com.kindgi.pack.Main index --pack-dir . [--output dist/index.json]
 *     [--artifact-version 20261001.1] [--published-at &lt;iso&gt;] [--json]
 * </pre>
 *
 * The Java counterpart of {@code kindgi-index} and {@code python -m kindgi.pack index}: reads
 * {@code kindgi.config.json}, discovers the source files under the {@code tools}, {@code
 * guardrails}, {@code agents} and {@code flows} packages (or the configured globs), loads each
 * one's class from the classpath, collects the primitives its static fields hold, and writes the
 * index atomically. Byte-deterministic: same classes and pinned {@code --artifact-version} and
 * {@code --published-at}, same bytes.
 *
 * <p>Fails loud, but per file: a class that fails to load, defines a primitive of the wrong kind
 * for its package, or (a public class) defines nothing is a file error, and the rest of the pack
 * still indexes. A helper class is package-private, or a record, an enum or an interface.
 */
final class Indexer {
  static final int INDEX_ENVELOPE_VERSION = 1;
  static final int KERNEL_PAYLOAD_VERSION = 1;

  private static final Map<String, String> FOLDERS = new LinkedHashMap<>();

  static {
    FOLDERS.put("tools", "tool");
    FOLDERS.put("guardrails", "guardrail");
    FOLDERS.put("agents", "agent");
    FOLDERS.put("flows", "flow");
  }

  private static final DateTimeFormatter PUBLISHED_AT =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private final PackConfig config;
  private final ClassLoader loader;
  private final List<Map<String, Object>> fileErrors = new ArrayList<>();

  private Indexer(PackConfig config, ClassLoader loader) {
    this.config = config;
    this.loader = loader;
  }

  /**
   * Indexes the pack. Never throws.
   *
   * @return {@code {"kind": "ok", "value": report}} or {@code {"kind": "err", "error": {code,
   *     message, …}}}
   */
  static Map<String, Object> run(
      Path packDir,
      @Nullable Path configPath,
      @Nullable Path outputPath,
      @Nullable String artifactVersion,
      @Nullable String publishedAt,
      ClassLoader loader) {
    Path root = packDir.toAbsolutePath().normalize();
    PackConfig config;
    try {
      config = PackConfig.load(root, configPath);
    } catch (PackConfig.ConfigException e) {
      return err(e.code(), e.getMessage(), e.path() == null ? null : e.path().toString(), e.field());
    }
    Map<String, @Nullable String> discovered = new TreeMap<>();
    for (String folder : FOLDERS.keySet()) {
      String pattern = config.discovery().get(folder);
      if (pattern == null) {
        continue;
      }
      for (String rel : Discovery.discover(root, pattern)) {
        discovered.putIfAbsent(rel, expectedKind(rel));
      }
    }
    if (discovered.isEmpty()) {
      return err("discovery-empty", "Indexer discovered zero files under " + root
          + ". Check the discovery patterns in " + PackConfig.FILE_NAME + ".", null, null);
    }
    return new Indexer(config, loader).index(root, discovered, outputPath, artifactVersion, publishedAt);
  }

  private Map<String, Object> index(
      Path root,
      Map<String, @Nullable String> discovered,
      @Nullable Path outputPath,
      @Nullable String artifactVersion,
      @Nullable String publishedAt) {
    Map<String, List<Map<String, Object>>> entries = new LinkedHashMap<>();
    for (String kind : FOLDERS.values()) {
      entries.put(kind, new ArrayList<>());
    }
    // Per kind and id, the versions defined so far and their files.
    Map<String, Map<@Nullable String, String>> owners = new LinkedHashMap<>();
    for (Map.Entry<String, @Nullable String> file : discovered.entrySet()) {
      String rel = file.getKey();
      String expected = file.getValue();
      if (rel.endsWith("/package-info.java") || rel.endsWith("/module-info.java")) {
        continue;
      }
      SourceLayout layout = SourceLayout.of(rel);
      if (layout == null) {
        fileErrors.add(fileError("file-import-failed", "File " + rel + " isn't a Java source under "
            + SourceLayout.JAVA.root() + " or a Scala source under " + SourceLayout.SCALA.root() + ", so it names no class",
            rel, null));
        continue;
      }
      String className = layout.className(rel);
      Class<?> type;
      try {
        type = Class.forName(className, true, loader);
      } catch (ClassNotFoundException e) {
        if (layout == SourceLayout.SCALA && isOnClasspath(layout.sourceName(rel), loader)) {
          // A Scala class or trait with no object: a helper, as a Java record is.
          continue;
        }
        fileErrors.add(fileError("file-import-failed", layout == SourceLayout.SCALA
            ? "Failed to load " + rel + ": object " + simpleName(layout.sourceName(rel)) + " (class " + className
                + ") isn't on the classpath. A Scala file's tools, guardrails, agents and flows are vals of an object"
                + " named like the file (compile the pack first)"
            : "Failed to load " + rel + ": class " + className + " isn't on the classpath (compile the pack first)", rel, null));
        continue;
      } catch (ExceptionInInitializerError e) {
        Throwable cause = e.getCause() == null ? e : e.getCause();
        fileErrors.add(fileError("file-import-failed",
            "Failed to load " + rel + ": " + cause.getClass().getName() + ": " + cause.getMessage(), rel, cause));
        continue;
      } catch (LinkageError e) {
        fileErrors.add(fileError("file-import-failed",
            "Failed to load " + rel + ": " + e.getClass().getName() + ": " + e.getMessage(), rel, e));
        continue;
      }
      List<Object> primitives;
      try {
        primitives = primitivesOf(type);
      } catch (RuntimeException e) {
        fileErrors.add(fileError("file-import-failed",
            "Failed to read the static fields of " + className + ": " + e, rel, e));
        continue;
      }
      if (primitives.isEmpty()) {
        if (layout == SourceLayout.SCALA) {
          // An object with no vals of primitives is a companion or a helper, unless it defines one
          // the indexer can't read without running it.
          List<String> unread = unreadDefinitions(type);
          if (!unread.isEmpty()) {
            fileErrors.add(fileError("no-primitives", "File " + rel + ": object " + simpleName(layout.sourceName(rel))
                + " defines " + String.join(", ", unread) + " as a def or a lazy val, which the indexer can't read"
                + " without running it; make it a val", rel, null));
          }
        } else if (!isHelper(type)) {
          fileErrors.add(fileError("no-primitives", "File " + rel + " defines no tool, guardrail, agent or flow in a"
              + " static field of " + className + " (a helper class is package-private, or a record, an enum or an"
              + " interface)", rel, null));
        }
        continue;
      }
      for (Object primitive : primitives) {
        String kind = kindOf(primitive);
        String id = idOf(primitive);
        if (expected != null && !kind.equals(expected)) {
          fileErrors.add(fileError("kind-mismatch", "File " + rel + " is in a " + folderOf(expected)
              + " package, the default folder for kind '" + expected + "', but defines a '" + kind + "' (" + id + ")", rel, null));
          continue;
        }
        Map<String, Object> entry;
        try {
          entry = build(primitive, rel);
        } catch (EntryException e) {
          fileErrors.add(manifestError(rel, e.getMessage()));
          continue;
        }
        // Several versions of one primitive may sit side by side (an agent version pins the one
        // it uses), keyed by the version the index records. The same version twice is an error,
        // and so is an entry with no version next to any other of its id.
        String version = (String) entry.get("version");
        Map<@Nullable String, String> defined = owners.computeIfAbsent(kind + "\u0000" + id, k -> new LinkedHashMap<>());
        String owner = version == null || defined.containsKey(null)
            ? defined.values().stream().findFirst().orElse(null)
            : defined.get(version);
        if (owner != null) {
          String what = kind + " '" + id + "'" + (version != null ? " version " + version : "");
          fileErrors.add(manifestError(rel, "duplicate " + what + " (also defined in " + owner + ")"));
          continue;
        }
        defined.put(version, rel);
        entries.get(kind).add(entry);
      }
    }

    Path output = (outputPath != null ? outputPath : root.resolve("index.json")).toAbsolutePath().normalize();
    String version = artifactVersion != null ? artifactVersion : autoArtifactVersion(output);
    String when = publishedAt != null ? publishedAt : PUBLISHED_AT.format(Instant.now().truncatedTo(ChronoUnit.MILLIS));
    Map<String, Object> index = new LinkedHashMap<>();
    index.put("v", INDEX_ENVELOPE_VERSION);
    index.put("packId", config.id());
    index.put("packVersion", config.version());
    index.put("artifactVersion", version);
    index.put("publishedAt", when);
    index.put("tools", sorted(entries.get("tool")));
    index.put("guardrails", sorted(entries.get("guardrail")));
    index.put("agents", sorted(entries.get("agent")));
    index.put("flows", sorted(entries.get("flow")));
    if (config.env() != null) {
      Map<String, Object> env = new LinkedHashMap<>();
      env.put("optional", config.env().optional());
      env.put("required", config.env().required());
      index.put("env", env);
    }
    Object plain = Json.plain(index);
    List<Map<String, Object>> issues = Specs.validator("pack-index").issues(plain);
    if (!issues.isEmpty()) {
      Map<String, Object> first = issues.get(0);
      String at = (String) first.get("instancePath");
      return err("manifest-validation-failed", "The index does not match pack-index.schema.json at "
          + (at.isEmpty() ? "/" : at) + ": " + first.get("message"), null, null);
    }
    try {
      atomicWrite(output, CanonicalJson.stable(plain) + "\n");
    } catch (IOException e) {
      return err("output-write-failed", "Failed to write " + output + ": " + e.getMessage(), output.toString(), null);
    }
    Map<String, Object> counts = new LinkedHashMap<>();
    FOLDERS.forEach((folder, kind) -> counts.put(folder, entries.get(kind).size()));
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("packId", config.id());
    value.put("packVersion", config.version());
    value.put("artifactVersion", version);
    value.put("publishedAt", when);
    value.put("counts", counts);
    value.put("outputPath", output.toString());
    value.put("fileErrors", fileErrors);
    Map<String, Object> outcome = new LinkedHashMap<>();
    outcome.put("kind", "ok");
    outcome.put("value", value);
    return outcome;
  }

  // ---------------------------------------------------------------------------------------------
  // Classes and primitives
  // ---------------------------------------------------------------------------------------------

  /**
   * {@code src/main/java/com/acme/tools/Greet.java} → {@code com.acme.tools.Greet}; {@code
   * src/main/scala/com/acme/tools/Greet.scala} → {@code com.acme.tools.Greet$} (the object);
   * {@code null} for any other path.
   */
  static @Nullable String className(String rel) {
    SourceLayout layout = SourceLayout.of(rel);
    return layout == null ? null : layout.className(rel);
  }

  private static String simpleName(String name) {
    return name.substring(name.lastIndexOf('.') + 1);
  }

  private static boolean isOnClasspath(String name, ClassLoader loader) {
    return loader.getResource(name.replace('.', '/') + ".class") != null;
  }

  /** The kind a file's package names: the last of its packages named {@code tools}, {@code guardrails}, …. */
  private static @Nullable String expectedKind(String rel) {
    SourceLayout layout = SourceLayout.of(rel);
    if (layout == null) {
      return null;
    }
    String[] segments = layout.segments(rel);
    for (int i = segments.length - 2; i >= 0; i--) {
      String kind = FOLDERS.get(segments[i]);
      if (kind != null) {
        return kind;
      }
    }
    return null;
  }

  private static String folderOf(String kind) {
    return FOLDERS.entrySet().stream().filter(e -> e.getValue().equals(kind)).findFirst().orElseThrow().getKey();
  }

  /**
   * The primitives the class's static fields hold, defined by the class (or one nested in it), in
   * field order; for a Scala object, its vals too, read through its {@code MODULE$}.
   */
  static List<Object> primitivesOf(Class<?> type) {
    List<Object> found = new ArrayList<>();
    Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    Object module = moduleOf(type);
    for (Field f : type.getDeclaredFields()) {
      boolean isStatic = Modifier.isStatic(f.getModifiers());
      if (f.isSynthetic() || (!isStatic && module == null)) {
        continue;
      }
      Object value;
      try {
        f.setAccessible(true);
        value = f.get(isStatic ? null : module);
      } catch (ReflectiveOperationException | RuntimeException e) {
        continue;
      }
      Class<?> definedIn = definedIn(value);
      if (definedIn != null && definedIn.getNestHost() == type && seen.add(value)) {
        found.add(value);
      }
    }
    return found;
  }

  /** A Scala object's instance ({@code MODULE$}); {@code null} for any other class. */
  private static @Nullable Object moduleOf(Class<?> type) {
    try {
      Field f = type.getDeclaredField("MODULE$");
      if (!Modifier.isStatic(f.getModifiers()) || f.getType() != type) {
        return null;
      }
      f.setAccessible(true);
      return f.get(null);
    } catch (ReflectiveOperationException | RuntimeException e) {
      return null;
    }
  }

  private static final List<Class<?>> PRIMITIVE_TYPES = List.of(Tool.class, Guardrail.class, Agent.class, Flow.class);

  /**
   * A Scala object's definitions of primitives that no val holds: a {@code def}, or a {@code lazy
   * val} not yet run. Each is a parameterless method returning a primitive type, with no field of its
   * name holding a value.
   */
  private static List<String> unreadDefinitions(Class<?> type) {
    Object module = moduleOf(type);
    if (module == null) {
      return List.of();
    }
    List<String> unread = new ArrayList<>();
    for (java.lang.reflect.Method m : type.getDeclaredMethods()) {
      if (m.getParameterCount() != 0 || m.isSynthetic() || Modifier.isStatic(m.getModifiers())
          || PRIMITIVE_TYPES.stream().noneMatch(p -> p.isAssignableFrom(m.getReturnType()))) {
        continue;
      }
      Object held = null;
      try {
        Field f = type.getDeclaredField(m.getName());
        f.setAccessible(true);
        held = f.get(module);
      } catch (ReflectiveOperationException | RuntimeException e) {
        // No field of that name: a def.
      }
      if (held == null) {
        unread.add(m.getName());
      }
    }
    unread.sort(null);
    return unread;
  }

  private static @Nullable Class<?> definedIn(@Nullable Object value) {
    if (value instanceof Tool) {
      return ((Tool<?, ?>) value).definedIn();
    }
    if (value instanceof Guardrail) {
      return ((Guardrail<?>) value).definedIn();
    }
    if (value instanceof Agent) {
      return ((Agent) value).definedIn();
    }
    if (value instanceof Flow) {
      return ((Flow) value).definedIn();
    }
    return null;
  }

  private static boolean isHelper(Class<?> type) {
    return !Modifier.isPublic(type.getModifiers()) || type.isRecord() || type.isEnum() || type.isInterface();
  }

  static String kindOf(Object primitive) {
    if (primitive instanceof Tool) {
      return "tool";
    }
    if (primitive instanceof Guardrail) {
      return "guardrail";
    }
    if (primitive instanceof Agent) {
      return "agent";
    }
    return "flow";
  }

  static String idOf(Object primitive) {
    if (primitive instanceof Tool) {
      return ((Tool<?, ?>) primitive).id();
    }
    if (primitive instanceof Guardrail) {
      return ((Guardrail<?>) primitive).id();
    }
    if (primitive instanceof Agent) {
      return ((Agent) primitive).id();
    }
    return ((Flow) primitive).id();
  }

  // ---------------------------------------------------------------------------------------------
  // Entries
  // ---------------------------------------------------------------------------------------------

  /** An entry the indexer can't write; a file error. */
  private static final class EntryException extends Exception {
    private static final long serialVersionUID = 1L;

    EntryException(String message) {
      super(message);
    }
  }

  private Map<String, Object> build(Object primitive, String rel) throws EntryException {
    Map<String, Object> entry;
    String kind = kindOf(primitive);
    if (primitive instanceof Tool) {
      entry = toolEntry((Tool<?, ?>) primitive, rel);
    } else if (primitive instanceof Guardrail) {
      entry = guardrailEntry((Guardrail<?>) primitive, rel);
    } else if (primitive instanceof Agent) {
      entry = agentEntry((Agent) primitive, rel);
    } else {
      entry = flowEntry((Flow) primitive, rel);
    }
    @SuppressWarnings("unchecked")
    Map<String, Object> plain = (Map<String, Object>) Json.plain(entry);
    List<Map<String, Object>> issues = Specs.validator("pack-index", kind).issues(plain);
    if (!issues.isEmpty()) {
      Map<String, Object> first = issues.get(0);
      Object additional = first.get("params") instanceof Map ? ((Map<?, ?>) first.get("params")).get("additionalProperty") : null;
      String at = (String) first.get("instancePath");
      throw new EntryException(kind + " '" + idOf(primitive) + "' is invalid at " + (at.isEmpty() ? "/" : at) + ": "
          + first.get("message") + (additional != null ? " ('" + additional + "')" : ""));
    }
    return plain;
  }

  private Map<String, Object> toolEntry(Tool<?, ?> tool, String rel) throws EntryException {
    Map<String, Object> input = schemaOf("tool '" + tool.id() + "' input", tool::inputSchema);
    Map<String, Object> output = schemaOf("tool '" + tool.id() + "' output", tool::outputSchema);
    Map<String, Object> e = new LinkedHashMap<>();
    e.put("id", tool.id());
    put(e, "description", tool.description());
    e.put("version", tool.version() != null ? tool.version() : config.version());
    e.put("input", input);
    e.put("output", output);
    e.put("effects", tool.effects());
    put(e, "mutating", tool.mutating());
    tool.extra().forEach(e::put);
    e.put("modulePath", rel);
    return e;
  }

  private Map<String, Object> guardrailEntry(Guardrail<?> guardrail, String rel) throws EntryException {
    Map<String, Object> e = new LinkedHashMap<>();
    e.put("id", guardrail.id());
    e.putAll(guardrail.entry());
    e.put("checkModulePath", rel);
    put(e, "checkId", guardrail.checkId());
    Map<String, Object> configSchema = schemaOf("guardrail '" + guardrail.id() + "' config", guardrail::configSchema);
    put(e, "configSchema", configSchema);
    return e;
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> agentEntry(Agent agent, String rel) throws EntryException {
    List<Object> tools = new ArrayList<>();
    for (Object ref : agent.tools()) {
      if (ref instanceof Tool) {
        Tool<?, ?> tool = (Tool<?, ?>) ref;
        Map<String, Object> pinned = new LinkedHashMap<>();
        pinned.put("id", tool.id());
        pinned.put("version", tool.version() != null ? tool.version() : config.version());
        tools.add(pinned);
      } else {
        tools.add(ref);
      }
    }
    Map<String, Object> e = new LinkedHashMap<>(agent.entry());
    e.put("tools", tools);
    e.put("modulePath", rel);
    return e;
  }

  private Map<String, Object> flowEntry(Flow flow, String rel) throws EntryException {
    @SuppressWarnings("unchecked")
    Map<String, Object> declared = (Map<String, Object>) Json.plain(flow.entry());
    Map<String, Object> issue = Specs.validator("flow").explain(declared);
    if (issue != null) {
      String at = (String) issue.get("instancePath");
      Object additional = issue.get("params") instanceof Map ? ((Map<?, ?>) issue.get("params")).get("additionalProperty") : null;
      throw new EntryException("flow '" + flow.id() + "' is invalid at " + (at.isEmpty() ? "/" : at) + ": "
          + issue.get("message") + (additional != null ? " ('" + additional + "')" : ""));
    }
    Map<String, Object> e = new LinkedHashMap<>(declared);
    e.put("kernelPayloadVersion", KERNEL_PAYLOAD_VERSION);
    e.put("modulePath", rel);
    return e;
  }

  private interface SchemaSource {
    @Nullable Map<String, Object> get();
  }

  /** A schema, derived or given, that the pack service's validator takes. */
  private static @Nullable Map<String, Object> schemaOf(String what, SchemaSource source) throws EntryException {
    Map<String, Object> schema;
    try {
      schema = source.get();
    } catch (SchemaDeriver.DerivationException e) {
      throw new EntryException(what + ": " + e.getMessage());
    }
    if (schema != null) {
      try {
        new SchemaValidator(schema);
      } catch (SchemaValidator.SchemaException e) {
        throw new EntryException(what + ": " + e.getMessage());
      }
    }
    return schema;
  }

  private static void put(Map<String, Object> e, String key, @Nullable Object value) {
    if (value != null) {
      e.put(key, value);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  private static List<Map<String, Object>> sorted(List<Map<String, Object>> entries) {
    List<Map<String, Object>> out = new ArrayList<>(entries);
    out.sort(Comparator.comparing(e -> (String) e.get("id")));
    return out;
  }

  static Map<String, Object> err(String code, String message, @Nullable String filePath, @Nullable String field) {
    Map<String, Object> error = new LinkedHashMap<>();
    error.put("code", code);
    error.put("message", message);
    put(error, "filePath", filePath);
    put(error, "field", field);
    Map<String, Object> outcome = new LinkedHashMap<>();
    outcome.put("kind", "err");
    outcome.put("error", error);
    return outcome;
  }

  private static Map<String, Object> fileError(String code, String message, String rel, @Nullable Throwable cause) {
    Map<String, Object> e = new LinkedHashMap<>();
    e.put("code", code);
    e.put("message", message);
    e.put("filePath", rel);
    if (cause != null) {
      StringWriter stack = new StringWriter();
      cause.printStackTrace(new PrintWriter(stack));
      Map<String, Object> c = new LinkedHashMap<>();
      c.put("name", cause.getClass().getName());
      c.put("message", String.valueOf(cause.getMessage()));
      c.put("stack", stack.toString());
      e.put("cause", c);
    }
    return e;
  }

  private static Map<String, Object> manifestError(String rel, String message) {
    return fileError("manifest-validation-failed", rel + ": " + message, rel, null);
  }

  private static String autoArtifactVersion(Path output) {
    String today = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC).format(Instant.now());
    int n = 1;
    try {
      Object previous = ((Map<?, ?>) Json.parse(Files.readAllBytes(output))).get("artifactVersion");
      String[] parts = String.valueOf(previous).split("\\.", 2);
      if (parts.length == 2 && parts[0].equals(today) && parts[1].matches("[0-9]+")) {
        n = Integer.parseInt(parts[1]) + 1;
      }
    } catch (IOException | RuntimeException e) {
      // No previous index, or not one this indexer wrote: start the day at 1.
    }
    return today + "." + n;
  }

  private static void atomicWrite(Path path, String text) throws IOException {
    Files.createDirectories(path.getParent());
    Path tmp = path.resolveSibling(path.getFileName() + ".tmp-" + ProcessHandle.current().pid() + "-" + System.currentTimeMillis());
    try {
      Files.writeString(tmp, text, StandardCharsets.UTF_8);
      try {
        Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      } catch (AtomicMoveNotSupportedException e) {
        Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
      }
    } finally {
      Files.deleteIfExists(tmp);
    }
  }
}
