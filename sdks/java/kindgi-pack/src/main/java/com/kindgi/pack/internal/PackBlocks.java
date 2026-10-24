// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * A pack's data blocks: its prompts and settings, one JSON file each. The Java counterpart of the
 * TypeScript {@code pack-blocks.ts} and Python's {@code blocks.py}, with the same checks and
 * messages.
 *
 * <p>The files are the ones the blocks discovery pattern matches ({@code blocks/**}{@code /*.json}
 * by default). A file holds the block as {@code kindgi blocks publish @<file>} takes it ({@code
 * id}, {@code version}, {@code kind}, {@code description}, {@code content}); a prompt may keep its
 * template in a file of its own ({@code content.templateFile}, relative to the block's file and
 * inside the blocks folder), read in here so the index holds the whole block. Whether the
 * template parses and the values satisfy their schema is checked by the CLI and again by a deploy.
 *
 * @param blocks the blocks, sorted by id
 * @param files every file read, relative to the pack root: block files and template files, sorted
 * @param errors the files refused ({@code message}, {@code filePath}), in discovery order
 */
public record PackBlocks(
    List<Map<String, Object>> blocks, List<String> files, List<Map<String, Object>> errors) {

  private static final Pattern ID = Pattern.compile("^[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)+$");
  private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+$");
  private static final List<String> BLOCK_FIELDS = List.of("id", "version", "kind", "description", "content");
  private static final Map<String, List<String>> CONTENT_FIELDS =
      Map.of("prompt", List.of("template", "templateFile", "parameters"), "settings", List.of("values", "schema"));
  private static final Set<String> SKIP_DIRS = Set.of("node_modules");

  /** One refused file. */
  private static final class Refused extends Exception {
    private static final long serialVersionUID = 1L;

    Refused(String message) {
      super(message);
    }
  }

  /**
   * @param pattern a blocks discovery glob
   * @return the folder it starts at, {@code ""} for the pack root: template files stay inside it
   */
  public static String folder(String pattern) {
    return Discovery.staticPrefix(pattern);
  }

  /**
   * Reads the pack's blocks: each file the pattern matches, checked, its template file read in.
   *
   * @param root the pack root
   * @param pattern the blocks discovery glob
   * @return the blocks, the files read and the files refused
   */
  public static PackBlocks read(Path root, String pattern) {
    String folder = folder(pattern);
    Pattern regex = Discovery.globToRegex(pattern);
    List<String> found = new ArrayList<>();
    Path start = folder.isEmpty() ? root : root.resolve(folder);
    if (Files.isDirectory(start, LinkOption.NOFOLLOW_LINKS)) {
      walk(root, folder, found, regex);
    }
    found.sort(null);

    List<Map<String, Object>> blocks = new ArrayList<>();
    Set<String> files = new TreeSet<>();
    List<Map<String, Object>> errors = new ArrayList<>();
    Map<String, String> owners = new LinkedHashMap<>();
    for (String rel : found) {
      Map<String, Object> block;
      List<String> templates = new ArrayList<>();
      try {
        block = readBlock(root, folder, rel, templates);
      } catch (Refused e) {
        errors.add(error(rel + ": " + e.getMessage(), rel));
        continue;
      }
      String id = (String) block.get("id");
      String owner = owners.get(id);
      if (owner != null) {
        errors.add(error(rel + ": duplicate block '" + id + "' (also defined in " + owner
            + "); a pack holds one version of each block", rel));
        continue;
      }
      owners.put(id, rel);
      blocks.add(block);
      files.add(rel);
      files.addAll(templates);
    }
    blocks.sort(Comparator.comparing(b -> (String) b.get("id")));
    return new PackBlocks(List.copyOf(blocks), List.copyOf(files), List.copyOf(errors));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> readBlock(Path root, String folder, String rel, List<String> templates)
      throws Refused {
    Object parsed;
    try {
      parsed = Json.parse(Files.readAllBytes(root.resolve(rel)));
    } catch (IOException | RuntimeException e) {
      throw new Refused("not a JSON file (" + e.getMessage() + ")");
    }
    if (!(parsed instanceof Map)) {
      throw new Refused("a block file holds one JSON object: the block");
    }
    Map<String, Object> b = (Map<String, Object>) parsed;
    for (String key : b.keySet()) {
      if (!BLOCK_FIELDS.contains(key)) {
        throw new Refused("unknown field \"" + key + "\" (a block has id, version, kind, description and content)");
      }
    }
    Object id = b.get("id");
    Object version = b.get("version");
    Object kind = b.get("kind");
    if (!(id instanceof String) || !ID.matcher((String) id).matches()) {
      throw new Refused("`id` must be a dotted lowercase id, e.g. \"acme.reply-prompt\"");
    }
    if (!(version instanceof String) || !VERSION.matcher((String) version).matches()) {
      throw new Refused("`version` must be major.minor.patch, e.g. \"1.0.0\"");
    }
    if (!"prompt".equals(kind) && !"settings".equals(kind)) {
      throw new Refused("`kind` must be \"prompt\" or \"settings\"");
    }
    if (b.containsKey("description") && !(b.get("description") instanceof String)) {
      throw new Refused("`description` must be a string");
    }
    if (!(b.get("content") instanceof Map)) {
      throw new Refused("`content` must be an object");
    }
    Map<String, Object> content = (Map<String, Object>) b.get("content");
    List<String> allowed = CONTENT_FIELDS.get((String) kind);
    for (String key : content.keySet()) {
      if (!allowed.contains(key)) {
        throw new Refused("unknown field \"content." + key + "\" (a " + kind + " block's content has "
            + String.join(", ", allowed) + ")");
      }
    }

    Map<String, Object> shown = new LinkedHashMap<>(content);
    if ("prompt".equals(kind)) {
      if (shown.containsKey("templateFile")) {
        Object templateFile = shown.remove("templateFile");
        if (shown.containsKey("template")) {
          throw new Refused("give `content.template` or `content.templateFile`, not both");
        }
        String path = templatePath(folder, rel, templateFile);
        shown.put("template", readTemplate(root, path, (String) templateFile));
        templates.add(path);
      }
      if (!(shown.get("template") instanceof String)) {
        throw new Refused("a prompt needs `content.template` (a Liquid template) or `content.templateFile`");
      }
      if (shown.containsKey("parameters") && !(shown.get("parameters") instanceof List)) {
        throw new Refused("`content.parameters` must be an array");
      }
    } else {
      if (!(content.get("values") instanceof Map)) {
        throw new Refused("settings need `content.values`, an object");
      }
      if (content.containsKey("schema") && !(content.get("schema") instanceof Map)) {
        throw new Refused("`content.schema` must be a JSON Schema object");
      }
    }

    Map<String, Object> block = new LinkedHashMap<>();
    block.put("id", id);
    block.put("version", version);
    block.put("kind", kind);
    if (b.containsKey("description")) {
      block.put("description", b.get("description"));
    }
    block.put("content", shown);
    block.put("modulePath", rel);
    return block;
  }

  /** A prompt's template file: relative to its block's file and inside the blocks folder. */
  private static String templatePath(String folder, String blockPath, Object templateFile) throws Refused {
    if (!(templateFile instanceof String) || ((String) templateFile).isEmpty()) {
      throw new Refused("`content.templateFile` must be a path relative to the block file");
    }
    String file = (String) templateFile;
    if (file.startsWith("/") || file.contains("\\")) {
      throw new Refused("`content.templateFile` \"" + file
          + "\" must be a path relative to the block file, with forward slashes");
    }
    int slash = blockPath.lastIndexOf('/');
    String path = normalize((slash < 0 ? "" : blockPath.substring(0, slash + 1)) + file);
    boolean inside = folder.isEmpty()
        ? !path.equals("..") && !path.startsWith("../")
        : path.startsWith(folder + "/");
    if (!inside) {
      String where = folder.isEmpty() ? "the pack" : "the blocks folder (" + folder + "/)";
      throw new Refused("`content.templateFile` \"" + file + "\" is outside " + where
          + "; keep a block's template next to it");
    }
    return path;
  }

  private static String readTemplate(Path root, String path, String file) throws Refused {
    Path abs = root.resolve(path);
    // Lexically inside isn't inside through a link: a link could put any file of the machine's
    // into the index, and so into a deploy.
    if (Files.isSymbolicLink(abs)) {
      throw new Refused("`content.templateFile` \"" + file
          + "\" is a symbolic link; keep the template itself in the blocks folder");
    }
    try {
      String text = StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(Files.readAllBytes(abs)))
          .toString();
      // A leading byte order mark isn't the template's, as the TypeScript and Python indexers read it.
      return text.startsWith("﻿") ? text.substring(1) : text;
    } catch (IOException e) {
      throw new Refused("`content.templateFile` \"" + file + "\" isn't a readable UTF-8 file (looked for "
          + path + ")");
    }
  }

  /** A {@code /}-separated relative path with {@code .} and {@code ..} resolved; leading {@code ..} kept. */
  private static String normalize(String path) {
    Deque<String> out = new ArrayDeque<>();
    for (String segment : path.split("/")) {
      if (segment.isEmpty() || segment.equals(".")) {
        continue;
      }
      if (segment.equals("..") && !out.isEmpty() && !out.peekLast().equals("..")) {
        out.removeLast();
      } else {
        out.addLast(segment);
      }
    }
    return String.join("/", out);
  }

  private static Map<String, Object> error(String message, String rel) {
    Map<String, Object> e = new LinkedHashMap<>();
    e.put("message", message);
    e.put("filePath", rel);
    return e;
  }

  /** Files under {@code rel}, {@code /}-separated; {@code node_modules}, dot entries and links skipped. */
  private static void walk(Path root, String rel, List<String> out, Pattern regex) {
    Path dir = rel.isEmpty() ? root : root.resolve(rel);
    List<Path> children;
    try (Stream<Path> list = Files.list(dir)) {
      children = new ArrayList<>(list.toList());
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    children.sort(null);
    for (Path child : children) {
      String name = child.getFileName().toString();
      if (name.startsWith(".") || SKIP_DIRS.contains(name) || Files.isSymbolicLink(child)) {
        continue;
      }
      String childRel = rel.isEmpty() ? name : rel + "/" + name;
      if (Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS)) {
        walk(root, childRel, out, regex);
      } else if (Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS) && regex.matcher(childRel).matches()) {
        out.add(childRel);
      }
    }
  }
}
