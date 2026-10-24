// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * A pack's data blocks ({@link PackBlocks}): one JSON file each, read into the index with a
 * prompt's template file inlined, and refused per file. The same cases and messages as the
 * TypeScript indexer's ({@code packages/handler-runtime/tests/pack-blocks.test.ts}).
 */
class PackBlocksTest {
  private static final String BLOCKS = "blocks/**/*.json";
  // The folder above a block's, for the templates a block names outside its own folder. The paths
  // start from UP rather than being string literals starting with ../, which
  // scripts/jvm-test-reads.test.mjs takes for repository files a test reads: these are paths inside
  // the test's own pack.
  private static final String UP = "..";

  @TempDir Path root;

  private static Map<String, Object> prompt(Map<String, Object> overrides) {
    Map<String, Object> b = new LinkedHashMap<>();
    b.put("id", "acme.reply-prompt");
    b.put("version", "1.2.0");
    b.put("kind", "prompt");
    b.put("description", "How the support agent replies");
    b.put("content", Map.of("template", "Reply to {{ customer_name }}.", "parameters", List.of()));
    b.putAll(overrides);
    return b;
  }

  private static Map<String, Object> settings(Map<String, Object> overrides) {
    Map<String, Object> b = new LinkedHashMap<>();
    b.put("id", "acme.reply-style");
    b.put("version", "1.0.0");
    b.put("kind", "settings");
    b.put("content", Map.of("values", Map.of("tone", "warm"),
        "schema", Map.of("type", "object", "properties", Map.of("tone", Map.of("type", "string")))));
    b.putAll(overrides);
    return b;
  }

  private static String json(Object value) {
    return Json.compactString(value) + "\n";
  }

  private void write(String rel, String content) throws Exception {
    write(rel, content.getBytes(StandardCharsets.UTF_8));
  }

  private void write(String rel, byte[] content) throws Exception {
    Path path = root.resolve(rel);
    Files.createDirectories(path.getParent());
    Files.write(path, content);
  }

  private static Map<String, Object> error(String message, String filePath) {
    return Map.of("message", message, "filePath", filePath);
  }

  @Test
  void readsEachBlockFileSortedByIdNamingItsFile() throws Exception {
    write("blocks/style.json", json(settings(Map.of())));
    write("blocks/support/reply.json", json(prompt(Map.of())));
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.errors()).isEmpty();
    Map<String, Object> reply = new LinkedHashMap<>(prompt(Map.of()));
    reply.put("modulePath", "blocks/support/reply.json");
    Map<String, Object> style = new LinkedHashMap<>(settings(Map.of()));
    style.put("modulePath", "blocks/style.json");
    assertThat(read.blocks()).containsExactly(reply, style);
    assertThat(read.files()).containsExactly("blocks/style.json", "blocks/support/reply.json");
  }

  @Test
  void aPromptsTemplateFileIsReadInRelativeToItsBlockFile() throws Exception {
    write("blocks/support/reply.json",
        json(prompt(Map.of("content", Map.of("templateFile", "reply.liquid", "parameters", List.of())))));
    write("blocks/support/reply.liquid", "Reply to {{ customer_name }}.\nKeep it short.\n");
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.errors()).isEmpty();
    assertThat(read.blocks().get(0).get("content"))
        .isEqualTo(Map.of("template", "Reply to {{ customer_name }}.\nKeep it short.\n", "parameters", List.of()));
    assertThat(read.files()).containsExactly("blocks/support/reply.json", "blocks/support/reply.liquid");
  }

  @Test
  void aTemplateElsewhereInTheFolderAndItsByteOrderMarkDropped() throws Exception {
    write("blocks/support/reply.json",
        json(prompt(Map.of("content", Map.of("templateFile", UP + "/templates/reply.liquid")))));
    write("blocks/templates/reply.liquid", new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf, 'H', 'i', '.'});
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.errors()).isEmpty();
    assertThat(read.blocks().get(0).get("content")).isEqualTo(Map.of("template", "Hi."));
  }

  static Stream<Arguments> badTemplates() {
    return Stream.of(
        Arguments.of(Map.of("template", "x", "templateFile", "reply.liquid"),
            "blocks/reply.json: give `content.template` or `content.templateFile`, not both"),
        Arguments.of(Map.of("templateFile", "nope.liquid"),
            "blocks/reply.json: `content.templateFile` \"nope.liquid\" isn't a readable UTF-8 file"
                + " (looked for blocks/nope.liquid)"),
        Arguments.of(Map.of("templateFile", UP + "/secrets.txt"),
            "blocks/reply.json: `content.templateFile` \"" + UP + "/secrets.txt\" is outside the blocks"
                + " folder (blocks/); keep a block's template next to it"),
        Arguments.of(Map.of("templateFile", "/etc/hosts"),
            "blocks/reply.json: `content.templateFile` \"/etc/hosts\" must be a path relative to the"
                + " block file, with forward slashes"),
        Arguments.of(Map.of("templateFile", "sub\\reply.liquid"),
            "blocks/reply.json: `content.templateFile` \"sub\\reply.liquid\" must be a path relative to"
                + " the block file, with forward slashes"),
        Arguments.of(Map.of("templateFile", ""),
            "blocks/reply.json: `content.templateFile` must be a path relative to the block file"),
        Arguments.of(Map.of("parameters", List.of()),
            "blocks/reply.json: a prompt needs `content.template` (a Liquid template) or `content.templateFile`"));
  }

  @ParameterizedTest
  @MethodSource("badTemplates")
  void refusesABadTemplateNamingTheFile(Map<String, Object> content, String message) throws Exception {
    write("secrets.txt", "not for the index");
    write("blocks/reply.json", json(prompt(Map.of("content", content))));
    write("blocks/other.json", json(settings(Map.of())));
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.errors()).containsExactly(error(message, "blocks/reply.json"));
    assertThat(read.blocks()).extracting(b -> b.get("id")).containsExactly("acme.reply-style");
    assertThat(read.files()).containsExactly("blocks/other.json");
  }

  @Test
  void aTemplateFileThatIsALinkIsRefused() throws Exception {
    write("blocks/reply.json", json(prompt(Map.of("content", Map.of("templateFile", "linked.liquid")))));
    write("blocks/real.liquid", "Hi.");
    Files.createSymbolicLink(root.resolve("blocks/linked.liquid"), root.resolve("blocks/real.liquid"));
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.errors()).containsExactly(error(
        "blocks/reply.json: `content.templateFile` \"linked.liquid\" is a symbolic link; keep the template"
            + " itself in the blocks folder",
        "blocks/reply.json"));
  }

  static Stream<Arguments> badBlocks() {
    Map<String, Object> withProject = new LinkedHashMap<>(prompt(Map.of()));
    withProject.put("projectId", "p");
    return Stream.of(
        Arguments.of("{ \"id\": ".getBytes(StandardCharsets.UTF_8), "^blocks/b\\.json: not a JSON file \\("),
        Arguments.of(new byte[] {'{', (byte) 0xff, '}'}, "^blocks/b\\.json: not a JSON file \\("),
        Arguments.of("{\"id\": NaN}".getBytes(StandardCharsets.UTF_8), "^blocks/b\\.json: not a JSON file \\("),
        Arguments.of(bytes(List.of(prompt(Map.of()))),
            "^blocks/b\\.json: a block file holds one JSON object: the block$"),
        Arguments.of(bytes(withProject),
            "^blocks/b\\.json: unknown field \"projectId\" \\(a block has id, version, kind, description and"
                + " content\\)$"),
        Arguments.of(bytes(prompt(Map.of("id", "Reply"))), "`id` must be a dotted lowercase id"),
        Arguments.of(bytes(prompt(Map.of("version", "^1.0.0"))), "`version` must be major\\.minor\\.patch"),
        Arguments.of(bytes(prompt(Map.of("kind", "tool"))), "`kind` must be \"prompt\" or \"settings\""),
        Arguments.of(bytes(prompt(Map.of("description", 3))), "`description` must be a string"),
        Arguments.of(bytes(prompt(Map.of("content", "Hi"))), "`content` must be an object"),
        Arguments.of(bytes(prompt(Map.of("content", Map.of("template", "x", "values", Map.of())))),
            "unknown field \"content\\.values\" \\(a prompt block's content has template, templateFile,"
                + " parameters\\)"),
        Arguments.of(bytes(prompt(Map.of("content", Map.of("template", "x", "parameters", Map.of())))),
            "`content\\.parameters` must be an array"),
        Arguments.of(bytes(settings(Map.of("content", Map.of()))), "settings need `content\\.values`, an object"),
        Arguments.of(bytes(settings(Map.of("content", Map.of("values", Map.of(), "schema", true)))),
            "`content\\.schema` must be a JSON Schema object"),
        Arguments.of(bytes(settings(Map.of("content", Map.of("values", Map.of(), "templateFile", "x")))),
            "unknown field \"content\\.templateFile\" \\(a settings block's content has values, schema\\)"));
  }

  private static byte[] bytes(Object value) {
    return json(value).getBytes(StandardCharsets.UTF_8);
  }

  @ParameterizedTest
  @MethodSource("badBlocks")
  void refusesABadBlock(byte[] content, String message) throws Exception {
    write("blocks/b.json", content);
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.blocks()).isEmpty();
    assertThat(read.errors()).hasSize(1);
    assertThat(read.errors().get(0).get("filePath")).isEqualTo("blocks/b.json");
    assertThat((String) read.errors().get(0).get("message")).containsPattern(message);
  }

  @Test
  void aBlockIdTwiceKeepsTheFirstFile() throws Exception {
    write("blocks/a.json", json(prompt(Map.of())));
    write("blocks/b.json", json(prompt(Map.of("version", "2.0.0"))));
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.blocks()).extracting(b -> b.get("modulePath") + "@" + b.get("version"))
        .containsExactly("blocks/a.json@1.2.0");
    assertThat(read.errors()).containsExactly(error(
        "blocks/b.json: duplicate block 'acme.reply-prompt' (also defined in blocks/a.json); a pack holds one"
            + " version of each block",
        "blocks/b.json"));
  }

  @Test
  void skipsDotFoldersNodeModulesLinksAndOtherFiles() throws Exception {
    write("blocks/.drafts/a.json", json(prompt(Map.of())));
    write("blocks/node_modules/a.json", json(prompt(Map.of())));
    write("blocks/notes.md", "# notes");
    write("blocks/real/style.json", json(settings(Map.of())));
    write("outside/linked.json", json(prompt(Map.of())));
    Files.createSymbolicLink(root.resolve("blocks/linked-dir"), root.resolve("outside"));
    Files.createSymbolicLink(root.resolve("blocks/linked.json"), root.resolve("outside/linked.json"));
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.errors()).isEmpty();
    assertThat(read.files()).containsExactly("blocks/real/style.json");
  }

  @Test
  void aPatternAtThePackRootKeepsTemplatesInsideThePack() throws Exception {
    write("support/reply.block.json",
        json(prompt(Map.of("content", Map.of("templateFile", UP + "/prompts/reply.liquid")))));
    write("prompts/reply.liquid", "Hi.");
    write("escape.block.json",
        json(prompt(Map.of("id", "acme.escape", "content", Map.of("templateFile", UP + "/outside.liquid")))));
    PackBlocks read = PackBlocks.read(root, "**/*.block.json");
    assertThat(read.blocks()).extracting(b -> b.get("id") + " " + b.get("content"))
        .containsExactly("acme.reply-prompt {template=Hi.}");
    assertThat(read.errors()).extracting(e -> e.get("message")).containsExactly(
        "escape.block.json: `content.templateFile` \"" + UP + "/outside.liquid\" is outside the pack; keep a"
            + " block's template next to it");
  }

  @Test
  void noBlocksFolderReadsNothing() {
    PackBlocks read = PackBlocks.read(root, BLOCKS);
    assertThat(read.blocks()).isEmpty();
    assertThat(read.files()).isEmpty();
    assertThat(read.errors()).isEmpty();
  }
}
