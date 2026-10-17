// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.internal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.annotation.JsonClassDescription;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyDescription;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.fasterxml.jackson.annotation.JsonValue;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/**
 * Derived schemas, against {@code derive/golden.json}. Ajv compiles every golden schema in strict
 * mode, and the corpus checks values against some of them ({@code "schemaFrom"}), so what Java
 * derives is what Ajv accepts. {@code -Dkindgi.golden.write=true} rewrites the golden file.
 */
class SchemaDeriverTest {
  record Greet(@Size(min = 1, max = 100) String name, @Nullable String title) {}

  @JsonClassDescription("A line of an invoice.")
  record Line(
      @JsonPropertyDescription("What was bought.") @NotBlank String item,
      @Positive int quantity,
      @DecimalMin("0.00") @DecimalMax(value = "100000", inclusive = false) BigDecimal price,
      Optional<String> note) {}

  enum Currency {
    EUR,
    USD,
    @JsonProperty("gbp")
    GBP
  }

  enum Priority {
    LOW("low"),
    HIGH("high");

    private final String wire;

    Priority(String wire) {
      this.wire = wire;
    }

    @JsonValue
    String wire() {
      return wire;
    }
  }

  record Invoice(
      UUID id,
      @NotEmpty List<Line> lines,
      Currency currency,
      @Nullable Priority priority,
      Set<String> tags,
      Map<String, Integer> totals,
      OffsetDateTime issuedAt,
      @Nullable LocalDate due,
      @Email String contact,
      URI link,
      @Pattern(regexp = "^[A-Z]{2}[0-9]+$") String reference,
      @Min(1) @Max(12) long month,
      @PositiveOrZero double discount,
      Object metadata) {}

  record WithDefaults(
      @JsonProperty(defaultValue = "1") int minLength,
      @JsonProperty(defaultValue = "true") boolean strict,
      @JsonProperty(defaultValue = "plain") String mode,
      @JsonProperty(value = "max_items", required = true) @Nullable Integer maxItems) {}

  @JsonIgnoreProperties(ignoreUnknown = true)
  record Open(String id) {}

  @JsonTypeInfo(use = JsonTypeInfo.Id.NAME, property = "kind")
  @JsonSubTypes({
    @JsonSubTypes.Type(value = Shape.Circle.class, name = "circle"),
    @JsonSubTypes.Type(value = Shape.Rect.class, name = "rect")
  })
  sealed interface Shape {
    record Circle(@Positive double radius) implements Shape {}

    record Rect(@Positive double width, @Positive double height) implements Shape {}
  }

  record Drawing(List<Shape> shapes, @Nullable Shape focus) {}

  /** A Jackson bean (not a record). */
  public static final class Bean {
    private String name = "";
    private @Nullable Integer age;

    public String getName() {
      return name;
    }

    public void setName(String name) {
      this.name = name;
    }

    public @Nullable Integer getAge() {
      return age;
    }

    public void setAge(@Nullable Integer age) {
      this.age = age;
    }
  }

  record Node(String name, List<Node> children) {}

  record Keyed(Map<Integer, String> byNumber) {}

  private static final Map<String, Class<?>> TYPES = new LinkedHashMap<>();

  static {
    TYPES.put("Greet", Greet.class);
    TYPES.put("Line", Line.class);
    TYPES.put("Invoice", Invoice.class);
    TYPES.put("WithDefaults", WithDefaults.class);
    TYPES.put("Open", Open.class);
    TYPES.put("Drawing", Drawing.class);
    TYPES.put("Bean", Bean.class);
  }

  @Test
  void derivedSchemasAreTheGoldenOnes() throws IOException {
    Map<String, Object> got = new LinkedHashMap<>();
    TYPES.forEach((name, type) -> got.put(name, SchemaDeriver.schema(type)));
    String text = CanonicalJson.stable(got);
    Path golden = Path.of("src/test/resources/derive/golden.json");
    if (Boolean.getBoolean("kindgi.golden.write")) {
      Files.writeString(golden, text, StandardCharsets.UTF_8);
    }
    try (InputStream in = SchemaDeriverTest.class.getResourceAsStream("/derive/golden.json")) {
      assertThat(in).as("derive/golden.json (write it with -Dkindgi.golden.write=true)").isNotNull();
      assertThat(text).isEqualTo(Files.readString(golden, StandardCharsets.UTF_8));
    }
  }

  @Test
  void everyDerivedSchemaIsOneTheValidatorTakes() {
    TYPES.forEach((name, type) -> new SchemaValidator(SchemaDeriver.schema(type)));
  }

  @Test
  void recursiveTypesFailSayingWhere() {
    assertThatThrownBy(() -> SchemaDeriver.schema(Node.class))
        .isInstanceOf(SchemaDeriver.DerivationException.class)
        .hasMessageContaining("Node.children[]")
        .hasMessageContaining("refers to itself");
  }

  @Test
  void mapsNeedStringKeys() {
    assertThatThrownBy(() -> SchemaDeriver.schema(Keyed.class))
        .isInstanceOf(SchemaDeriver.DerivationException.class)
        .hasMessageContaining("byNumber")
        .hasMessageContaining("keys must be strings");
  }

  @Test
  void aDefaultedPropertyIsOptionalAndTheValidatorFillsIt() {
    Map<String, Object> schema = SchemaDeriver.schema(WithDefaults.class);
    @SuppressWarnings("unchecked")
    Object filled = Defaults.apply(schema, new LinkedHashMap<>(Map.of("max_items", 3)));
    assertThat(new SchemaValidator(schema).issues(filled)).isEmpty();
    assertThat(Json.bind(filled, WithDefaults.class))
        .isEqualTo(new WithDefaults(1, true, "plain", 3));
  }
}
