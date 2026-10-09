// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import com.palantir.javapoet.AnnotationSpec;
import com.palantir.javapoet.ClassName;
import com.palantir.javapoet.CodeBlock;
import com.palantir.javapoet.JavaFile;
import com.palantir.javapoet.MethodSpec;
import com.palantir.javapoet.ParameterSpec;
import com.palantir.javapoet.ParameterizedTypeName;
import com.palantir.javapoet.TypeName;
import com.palantir.javapoet.TypeSpec;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import javax.lang.model.element.Modifier;

/**
 * Writes the client's JSON codec for the models: Jackson mix-ins that carry, for the client's own
 * (shaded) Jackson, what the models' annotations say to an app's Jackson. The models stay free of
 * the client's Jackson, so an app's own mapper reads and writes them, whatever Jackson it has.
 *
 * <p>One file per top-level model ({@code RunJson}) holds its mix-ins, its codecs and a {@code
 * register}; {@code ModelCodecs.register} calls them all.
 */
final class MixInWriter {
  static final String CODEC = "com.kindgi.client.internal.codec";
  private static final ClassName SIMPLE_MODULE = ClassName.get("tools.jackson.databind.module", "SimpleModule");
  private static final ClassName TEXT_VALUES = ClassName.get(CODEC, "TextValues");

  private final ModelPlanner planner;
  /** The file being written: mix-ins and codecs are nested in it. */
  private ClassName current;

  MixInWriter(ModelPlanner planner) {
    this.planner = planner;
  }

  List<JavaFile> files() {
    List<JavaFile> out = new ArrayList<>();
    MethodSpec.Builder all =
        MethodSpec.methodBuilder("register")
            .addJavadoc("Adds every model's codec to {@code module}.\n\n@param module the client's module\n")
            .addModifiers(Modifier.PUBLIC, Modifier.STATIC)
            .addParameter(SIMPLE_MODULE, "module");
    for (Ir.Decl d : planner.decls.values()) {
      if (!d.name().packageName().equals(ModelPlanner.MODELS)) {
        continue;
      }
      ClassName file = ClassName.get(CODEC, d.name().simpleName() + "Json");
      current = file;
      TypeSpec.Builder tb =
          TypeSpec.classBuilder(file)
              .addModifiers(Modifier.FINAL)
              .addJavadoc("The client's JSON codec for {@link $T}.\n", d.name())
              .addMethod(MethodSpec.constructorBuilder().addModifiers(Modifier.PRIVATE).build());
      MethodSpec.Builder register =
          MethodSpec.methodBuilder("register").addModifiers(Modifier.STATIC).addParameter(SIMPLE_MODULE, "module");
      Set<String> names = new HashSet<>();
      emit(d, tb, register, names);
      tb.addMethod(register.build());
      out.add(ModelWriter.file(CODEC, tb.build()));
      all.addStatement("$T.register(module)", file);
    }
    TypeSpec registry =
        TypeSpec.classBuilder(ClassName.get(CODEC, "ModelCodecs"))
            .addModifiers(Modifier.PUBLIC, Modifier.FINAL)
            .addJavadoc("The client's JSON codec for every model.\n")
            .addMethod(MethodSpec.constructorBuilder().addModifiers(Modifier.PRIVATE).build())
            .addMethod(all.build())
            .build();
    out.add(ModelWriter.file(CODEC, registry));
    return out;
  }

  private void emit(Ir.Decl d, TypeSpec.Builder file, MethodSpec.Builder register, Set<String> names) {
    if (d instanceof Ir.RecordDecl) {
      Ir.RecordDecl r = (Ir.RecordDecl) d;
      file.addType(recordMixIn(r, mixInName(r.name, names), register));
      for (Ir.Decl n : r.nested) {
        emit(n, file, register, names);
      }
    } else if (d instanceof Ir.EnumDecl) {
      register.addStatement("$T.register(module, $T.class, $T::of, $T::asString)", TEXT_VALUES, d.name(), d.name(), d.name());
    } else {
      Ir.UnionDecl u = (Ir.UnionDecl) d;
      union(u, file, register, names);
      for (Ir.Decl n : u.nested) {
        emit(n, file, register, names);
      }
    }
  }

  private static String mixInName(ClassName target, Set<String> names) {
    String name = String.join("", target.simpleNames()) + "MixIn";
    if (!names.add(name)) {
      throw new GenerationException("two mix-ins named " + name);
    }
    return name;
  }

  /** A record's mix-in: its accessors' wire names, tri-state filters, and kept unknown properties. */
  private TypeSpec recordMixIn(Ir.RecordDecl r, String name, MethodSpec.Builder register) {
    ClassName mixIn = current.nestedClass(name);
    TypeSpec.Builder tb = TypeSpec.classBuilder(name).addModifiers(Modifier.ABSTRACT, Modifier.STATIC);
    if (inTextUnion(r.interfaces)) {
      tb.addAnnotation(readAsItself());
    }
    MethodSpec.Builder ctor = MethodSpec.constructorBuilder();
    for (Ir.Field f : r.fields) {
      TypeName type = f.triState ? ParameterizedTypeName.get(ModelWriter.OPTIONAL_NULLABLE, f.type) : f.type;
      MethodSpec.Builder accessor =
          MethodSpec.methodBuilder(f.java)
              .addModifiers(Modifier.ABSTRACT)
              .returns(type)
              .addAnnotation(property(f.wire));
      if (f.triState) {
        accessor.addAnnotation(
            AnnotationSpec.builder(ModelWriter.JSON_INCLUDE)
                .addMember("value", "$T.Include.CUSTOM", ModelWriter.JSON_INCLUDE)
                .addMember("valueFilter", "$T.AbsentFilter.class", ModelWriter.OPTIONAL_NULLABLE)
                .build());
      }
      tb.addMethod(accessor.build());
      ctor.addParameter(ParameterSpec.builder(type, f.java).addAnnotation(property(f.wire)).build());
    }
    if (r.open) {
      TypeName extras = ParameterizedTypeName.get(ModelPlanner.MAP, ModelPlanner.STRING, r.openValueType);
      tb.addMethod(
          MethodSpec.methodBuilder("additionalProperties")
              .addModifiers(Modifier.ABSTRACT)
              .returns(extras)
              .addAnnotation(ModelWriter.JSON_ANY_GETTER)
              .build());
      ctor.addParameter(ParameterSpec.builder(extras, "additionalProperties").addAnnotation(ModelWriter.JSON_ANY_SETTER).build());
      // The unknown properties go in through the constructor: a mix-in constructor names them.
      tb.addMethod(ctor.build());
    }
    register.addStatement("module.setMixInAnnotation($T.class, $T.class)", r.name, mixIn);
    return tb.build();
  }

  private void union(Ir.UnionDecl u, TypeSpec.Builder file, MethodSpec.Builder register, Set<String> names) {
    ClassName cn = u.name;
    if (u.kind == Ir.UnionKind.BY_STATUS) {
      return; // Read by status: the transport picks the variant.
    }
    String name = mixInName(cn, names);
    TypeSpec.Builder mixIn = TypeSpec.interfaceBuilder(name).addModifiers(Modifier.STATIC);
    boolean tagged = u.kind == Ir.UnionKind.TAGGED;
    if (tagged || u.kind == Ir.UnionKind.DEDUCED) {
      AnnotationSpec.Builder info = AnnotationSpec.builder(ModelWriter.JSON_TYPE_INFO);
      if (tagged) {
        info.addMember("use", "$T.Id.NAME", ModelWriter.JSON_TYPE_INFO)
            .addMember("include", "$T.As.EXISTING_PROPERTY", ModelWriter.JSON_TYPE_INFO)
            .addMember("property", "$S", u.tagWire)
            .addMember("visible", "true");
      } else {
        info.addMember("use", "$T.Id.DEDUCTION", ModelWriter.JSON_TYPE_INFO);
      }
      info.addMember("defaultImpl", "$T.class", u.unrecognized);
      mixIn.addAnnotation(info.build());
      AnnotationSpec.Builder subs = AnnotationSpec.builder(ModelWriter.JSON_SUB_TYPES);
      for (Ir.Variant v : u.variants) {
        AnnotationSpec.Builder t =
            AnnotationSpec.builder(ModelWriter.JSON_SUB_TYPES.nestedClass("Type")).addMember("value", "$T.class", v.type());
        if (tagged) {
          if (v.tags().size() == 1) {
            t.addMember("name", "$S", v.tags().get(0));
          } else {
            CodeBlock.Builder arr = CodeBlock.builder().add("{");
            for (int i = 0; i < v.tags().size(); i++) {
              arr.add(i == 0 ? "$S" : ", $S", v.tags().get(i));
            }
            t.addMember("names", "$L", arr.add("}").build());
          }
        }
        subs.addMember("value", "$L", t.build());
      }
      mixIn.addAnnotation(subs.build());
    } else {
      ClassName codec = current.nestedClass(String.join("", cn.simpleNames()) + "Codec");
      mixIn.addAnnotation(AnnotationSpec.builder(ModelWriter.JSON_DESERIALIZE).addMember("using", "$T.class", codec).build());
      file.addType(codec(u, codec));
      Ir.Variant text = u.textVariant();
      String textName = mixInName(text.type(), names);
      file.addType(
          TypeSpec.classBuilder(textName)
              .addModifiers(Modifier.ABSTRACT, Modifier.STATIC)
              .addMethod(
                  MethodSpec.methodBuilder("value")
                      .addModifiers(Modifier.ABSTRACT)
                      .returns(ModelPlanner.STRING)
                      .addAnnotation(ModelWriter.JSON_VALUE)
                      .build())
              .build());
      register.addStatement("module.setMixInAnnotation($T.class, $T.class)", text.type(), current.nestedClass(textName));
    }
    file.addType(mixIn.build());
    register.addStatement("module.setMixInAnnotation($T.class, $T.class)", cn, current.nestedClass(name));
    if (u.unrecognized != null) {
      file.addType(unrecognizedMixIn(u, mixInName(u.unrecognized, names), register));
    }
  }

  private TypeSpec unrecognizedMixIn(Ir.UnionDecl u, String name, MethodSpec.Builder register) {
    TypeName props = ParameterizedTypeName.get(ModelPlanner.MAP, ModelPlanner.STRING, ModelPlanner.OBJECT);
    TypeSpec.Builder tb = TypeSpec.classBuilder(name).addModifiers(Modifier.ABSTRACT, Modifier.STATIC);
    if (u.kind == Ir.UnionKind.TEXT_OR_OBJECT) {
      tb.addAnnotation(readAsItself());
    }
    MethodSpec.Builder ctor = MethodSpec.constructorBuilder();
    if (u.objectKind == Ir.UnionKind.TAGGED) {
      ctor.addParameter(ParameterSpec.builder(ModelPlanner.STRING, u.tagJava).addAnnotation(property(u.tagWire)).build());
      tb.addMethod(
          MethodSpec.methodBuilder(u.tagJava)
              .addModifiers(Modifier.ABSTRACT)
              .returns(ModelPlanner.STRING)
              .addAnnotation(property(u.tagWire))
              .build());
    }
    ctor.addParameter(ParameterSpec.builder(props, "properties").addAnnotation(ModelWriter.JSON_ANY_SETTER).build());
    tb.addMethod(ctor.build());
    tb.addMethod(
        MethodSpec.methodBuilder("properties")
            .addModifiers(Modifier.ABSTRACT)
            .returns(props)
            .addAnnotation(ModelWriter.JSON_ANY_GETTER)
            .build());
    register.addStatement("module.setMixInAnnotation($T.class, $T.class)", u.unrecognized, current.nestedClass(name));
    return tb.build();
  }

  /** The deserializer of a text-or-object union: a string is the text variant, an object the rest. */
  private TypeSpec codec(Ir.UnionDecl u, ClassName codec) {
    ClassName cn = u.name;
    Ir.Variant text = u.textVariant();
    List<Ir.Variant> objects = new ArrayList<>();
    for (Ir.Variant v : u.variants) {
      if (!v.text()) {
        objects.add(v);
      }
    }
    CodeBlock.Builder body = CodeBlock.builder();
    body.beginControlFlow("if (p.currentToken() == $T.VALUE_STRING)", ModelWriter.JSON_TOKEN)
        .addStatement("return new $T(p.getString())", text.type())
        .endControlFlow();
    body.beginControlFlow("if (p.currentToken() != $T.START_OBJECT)", ModelWriter.JSON_TOKEN)
        .addStatement("return ($T) ctxt.handleUnexpectedToken($T.class, p)", cn, cn)
        .endControlFlow();
    if (objects.size() == 1) {
      body.addStatement("return ctxt.readValue(p, $T.class)", objects.get(0).type());
    } else {
      body.addStatement("$T node = ctxt.readTree(p)", ModelWriter.JSON_NODE);
      if (u.objectKind == Ir.UnionKind.TAGGED) {
        body.addStatement("$T tag = node.get($S)", ModelWriter.JSON_NODE, u.tagWire);
        body.addStatement("$T value = tag != null && tag.isString() ? tag.stringValue() : $S", ModelPlanner.STRING, "");
        body.beginControlFlow("switch (value)");
        for (Ir.Variant v : objects) {
          for (String t : v.tags()) {
            body.add("case $S:\n", t);
          }
          body.indent().addStatement("return ctxt.readTreeAsValue(node, $T.class)", v.type()).unindent();
        }
        body.add("default:\n").indent().addStatement("return ctxt.readTreeAsValue(node, $T.class)", u.unrecognized).unindent();
        body.endControlFlow();
      } else {
        for (Ir.Variant v : objects) {
          body.beginControlFlow("if (node.has($S))", v.uniqueRequired().get(0))
              .addStatement("return ctxt.readTreeAsValue(node, $T.class)", v.type())
              .endControlFlow();
        }
        body.addStatement("return ctxt.readTreeAsValue(node, $T.class)", u.unrecognized);
      }
    }
    return TypeSpec.classBuilder(codec)
        .addModifiers(Modifier.STATIC, Modifier.FINAL)
        .superclass(ParameterizedTypeName.get(ModelWriter.VALUE_DESERIALIZER, cn))
        .addJavadoc("Reads a {@link $T}: a string is its text, an object one of its object variants.\n", cn)
        .addMethod(
            MethodSpec.methodBuilder("deserialize")
                .addAnnotation(Override.class)
                .addModifiers(Modifier.PUBLIC)
                .returns(cn)
                .addParameter(ModelWriter.JSON_PARSER, "p")
                .addParameter(ModelWriter.DESER_CONTEXT, "ctxt")
                .addCode(body.build())
                .build())
        .build();
  }

  private boolean inTextUnion(Set<ClassName> interfaces) {
    for (ClassName i : interfaces) {
      Ir.Decl u = planner.index.get(i);
      if (u instanceof Ir.UnionDecl && ((Ir.UnionDecl) u).kind == Ir.UnionKind.TEXT_OR_OBJECT) {
        return true;
      }
    }
    return false;
  }

  /**
   * A variant of a text-or-object union is read as itself; it would otherwise inherit the union's
   * codec, which reads the variant: a loop.
   */
  private static AnnotationSpec readAsItself() {
    return AnnotationSpec.builder(ModelWriter.JSON_DESERIALIZE).addMember("using", "$T.None.class", ModelWriter.VALUE_DESERIALIZER).build();
  }

  private static AnnotationSpec property(String wire) {
    return AnnotationSpec.builder(ModelWriter.JSON_PROPERTY).addMember("value", "$S", wire).build();
  }
}
