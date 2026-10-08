// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import com.palantir.javapoet.ArrayTypeName;
import com.palantir.javapoet.ClassName;
import com.palantir.javapoet.CodeBlock;
import com.palantir.javapoet.FieldSpec;
import com.palantir.javapoet.JavaFile;
import com.palantir.javapoet.MethodSpec;
import com.palantir.javapoet.ParameterSpec;
import com.palantir.javapoet.ParameterizedTypeName;
import com.palantir.javapoet.TypeName;
import com.palantir.javapoet.TypeSpec;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import javax.lang.model.element.Modifier;

/** Writes the resource classes, the operation table and the clients' generated bases. */
final class ResourceWriter {
  static final String CLIENT = "com.kindgi.client";
  static final String INTERNAL = "com.kindgi.client.internal";
  static final ClassName TRANSPORT = ClassName.get(INTERNAL, "Transport");
  static final ClassName REQUEST = ClassName.get(INTERNAL, "RequestSpec");
  static final ClassName MULTIPART = ClassName.get(INTERNAL, "Multipart");
  static final ClassName OPERATION = ClassName.get(INTERNAL, "Operation");
  static final ClassName OPERATIONS = ClassName.get(INTERNAL, "Operations");
  static final ClassName EVENT_STREAM = ClassName.get(CLIENT, "EventStream");
  static final ClassName API_EXCEPTION = ClassName.get(CLIENT, "KindgiApiException");
  static final ClassName TYPE_REFERENCE = ClassName.get("tools.jackson.core.type", "TypeReference");
  static final ClassName FUTURE = ClassName.get(CompletableFuture.class);
  static final ClassName PUBLISHER = ClassName.get(Flow.Publisher.class);
  static final ClassName PAGING = ClassName.get(INTERNAL, "Paging");
  static final ClassName STREAM = ClassName.get(java.util.stream.Stream.class);

  /**
   * A run's event streams, which the server ends after the run's terminal event or after a time
   * limit: each gets a method that follows it through to the end, reconnecting with {@code
   * Last-Event-Id} ({@code runs.stream} → {@code follow}), as the TypeScript client's streams do.
   */
  static final Map<String, String> FOLLOWS = Map.of("runs.stream", "follow", "runs.progressStream", "followProgress");

  private final OperationPlanner ops;
  private final ModelPlanner models;

  ResourceWriter(OperationPlanner ops, ModelPlanner models) {
    this.ops = ops;
    this.models = models;
  }

  List<JavaFile> files() {
    List<JavaFile> out = new ArrayList<>();
    if (!ops.root.ops.isEmpty()) {
      throw new GenerationException("operations without a resource (an id with no dot) aren't supported");
    }
    for (OperationPlanner.Resource r : ops.root.children.values()) {
      resources(r, out);
    }
    out.add(ModelWriter.file(INTERNAL, operations()));
    out.add(ModelWriter.file(CLIENT, api(false)));
    out.add(ModelWriter.file(CLIENT, api(true)));
    return out;
  }

  private void resources(OperationPlanner.Resource r, List<JavaFile> out) {
    out.add(ModelWriter.file(OperationPlanner.RESOURCES, resource(r, false)));
    out.add(ModelWriter.file(OperationPlanner.RESOURCES, resource(r, true)));
    for (OperationPlanner.Resource child : r.children.values()) {
      resources(child, out);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The clients' bases
  // ---------------------------------------------------------------------------------------------

  private TypeSpec api(boolean async) {
    ClassName cn = ClassName.get(CLIENT, async ? "KindgiAsyncApi" : "KindgiApi");
    ClassName sub = ClassName.get(CLIENT, async ? "KindgiAsync" : "Kindgi");
    TypeSpec.Builder tb =
        TypeSpec.classBuilder(cn)
            .addModifiers(Modifier.PUBLIC, Modifier.ABSTRACT, Modifier.SEALED)
            .addPermittedSubclass(sub)
            .addJavadoc(
                "Every resource of the Kindgi API$L, as {@link $T} has them. Generated from the API's"
                    + " operations: the operation id {@code approvals.reviewers.list} is {@code"
                    + " client.approvals().reviewers().list()}.\n",
                async ? ", asynchronously" : "",
                sub);
    MethodSpec.Builder ctor = MethodSpec.constructorBuilder().addParameter(TRANSPORT, "transport");
    for (Map.Entry<String, OperationPlanner.Resource> e : ops.root.children.entrySet()) {
      ClassName rc = e.getValue().className(async);
      String name = Names.camel(e.getKey());
      tb.addField(FieldSpec.builder(rc, name, Modifier.PRIVATE, Modifier.FINAL).build());
      ctor.addStatement("this.$N = new $T(transport)", name, rc);
      tb.addMethod(
          MethodSpec.methodBuilder(name)
              .addJavadoc("The {@code $L} operations.\n\n@return the resource\n", e.getKey())
              .addModifiers(Modifier.PUBLIC)
              .returns(rc)
              .addStatement("return $N", name)
              .build());
    }
    tb.addMethod(ctor.build());
    return tb.build();
  }

  // ---------------------------------------------------------------------------------------------
  // Operation table
  // ---------------------------------------------------------------------------------------------

  private TypeSpec operations() {
    TypeSpec.Builder tb =
        TypeSpec.classBuilder(OPERATIONS)
            .addModifiers(Modifier.PUBLIC, Modifier.FINAL)
            .addJavadoc("Every operation of the Kindgi API with a client method.\n");
    tb.addMethod(MethodSpec.constructorBuilder().addModifiers(Modifier.PRIVATE).build());
    CodeBlock.Builder all = CodeBlock.builder().add("$T.ofEntries(", Map.class);
    int i = 0;
    for (OperationPlanner.Op op : ops.ops) {
      if (!op.operationConstant.equals(Names.constant(op.id))) {
        continue; // an alias: the same operation as its original
      }
      tb.addField(
          FieldSpec.builder(OPERATION, op.operationConstant, Modifier.PUBLIC, Modifier.STATIC, Modifier.FINAL)
              .addJavadoc("{@code $L}: <code>$L $L</code>\n", op.id, op.method, Docs.javadoc(op.path))
              .initializer(
                  "new $T($S, $S, $S, $T.Kind.$L, $L)",
                  OPERATION,
                  op.id,
                  op.method,
                  op.path,
                  OPERATION,
                  op.responseKind.name(),
                  op.idempotencyKey)
              .build());
      all.add(i++ == 0 ? "\n$>$T.entry($S, $L)" : ",\n$T.entry($S, $L)", Map.class, op.id, op.operationConstant);
    }
    all.add("$<)");
    tb.addField(
        FieldSpec.builder(ParameterizedTypeName.get(ModelPlanner.MAP, ModelPlanner.STRING, OPERATION), "ALL", Modifier.PUBLIC, Modifier.STATIC, Modifier.FINAL)
            .addJavadoc("Every operation, by its id.\n")
            .initializer(all.build())
            .build());
    CodeBlock.Builder skipped = CodeBlock.builder().add("$T.of(", Set.class);
    int j = 0;
    for (String id : ops.skipped) {
      skipped.add(j++ == 0 ? "$S" : ", $S", id);
    }
    skipped.add(")");
    tb.addField(
        FieldSpec.builder(ParameterizedTypeName.get(ClassName.get(Set.class), ModelPlanner.STRING), "WITHOUT_METHOD", Modifier.PUBLIC, Modifier.STATIC, Modifier.FINAL)
            .addJavadoc("The API's operations that have no client method ({@code HEAD}).\n")
            .initializer(skipped.build())
            .build());
    return tb.build();
  }

  // ---------------------------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------------------------

  private TypeSpec resource(OperationPlanner.Resource r, boolean async) {
    ClassName cn = r.className(async);
    String dotted = String.join(".", r.path);
    TypeSpec.Builder tb =
        TypeSpec.classBuilder(cn)
            .addModifiers(Modifier.PUBLIC, Modifier.FINAL)
            .addJavadoc(
                "The {@code $L} operations$L: {@code client.$L}.\n",
                dotted,
                async ? ", asynchronously" : "",
                accessorChain(r.path));
    tb.addField(FieldSpec.builder(TRANSPORT, "transport", Modifier.PRIVATE, Modifier.FINAL).build());
    MethodSpec.Builder ctor =
        MethodSpec.constructorBuilder()
            .addJavadoc("For the client; you get a resource from it.\n\n@param transport the client's transport\n")
            .addModifiers(Modifier.PUBLIC)
            .addParameter(TRANSPORT, "transport")
            .addStatement("this.transport = transport");
    for (Map.Entry<String, OperationPlanner.Resource> e : r.children.entrySet()) {
      ClassName rc = e.getValue().className(async);
      String name = Names.camel(e.getKey());
      tb.addField(FieldSpec.builder(rc, name, Modifier.PRIVATE, Modifier.FINAL).build());
      ctor.addStatement("this.$N = new $T(transport)", name, rc);
      tb.addMethod(
          MethodSpec.methodBuilder(name)
              .addJavadoc("The {@code $L.$L} operations.\n\n@return the resource\n", dotted, e.getKey())
              .addModifiers(Modifier.PUBLIC)
              .returns(rc)
              .addStatement("return $N", name)
              .build());
    }
    tb.addMethod(ctor.build());
    for (OperationPlanner.Op op : r.ops) {
      for (MethodSpec m : methods(op, async)) {
        tb.addMethod(m);
      }
      if (FOLLOWS.containsKey(op.id)) {
        tb.addMethod(follow(op, async, FOLLOWS.get(op.id)));
      }
      if (op.pageItem != null && !async) {
        tb.addMethod(autoPaging(op, true));
        if (op.paramsOptional) {
          tb.addMethod(autoPaging(op, false));
        }
      }
    }
    return tb.build();
  }

  private static String accessorChain(List<String> path) {
    StringBuilder sb = new StringBuilder();
    for (String p : path) {
      if (sb.length() > 0) {
        sb.append('.');
      }
      sb.append(Names.camel(p)).append("()");
    }
    return sb.toString();
  }

  /** {@code follow(runId)}: a run's stream, through to its terminal event. */
  private MethodSpec follow(OperationPlanner.Op op, boolean async, String name) {
    if (op.responseKind != OperationPlanner.ResponseKind.SSE) {
      throw new GenerationException(op.id + ": only an event stream can be followed");
    }
    MethodSpec.Builder m =
        MethodSpec.methodBuilder(name)
            .addModifiers(Modifier.PUBLIC)
            .returns(returns(op, async));
    CodeBlock.Builder doc = CodeBlock.builder();
    doc.add("Follows a run's events through to its end: {@code run.completed}, {@code run.failed} or {@code run.cancelled}.\n\n");
    doc.add("<p><code>$L $L</code> ({@code $L}), reconnected: the server ends a stream after a time limit while the run is still going, and this reconnects with {@code Last-Event-Id}, so each event comes once. $L\n\n",
        op.method, Docs.javadoc(op.path), op.id, async ? "Cancel the subscription to stop early." : "Close it to stop early.");
    for (OperationPlanner.PathParam p : op.pathParams) {
      String d = Docs.javadoc(p.description());
      doc.add("@param $L $L\n", p.java(), d.isEmpty() ? "the {@code " + p.wire() + "}" : d);
      m.addParameter(p.type(), p.java());
    }
    doc.add("@return the events, through to the run's terminal one\n");
    doc.add("@throws $T when the API refuses the call or can't be reached\n", API_EXCEPTION);
    m.addJavadoc(doc.build());
    for (OperationPlanner.PathParam p : op.pathParams) {
      m.addStatement("$T.requireNonNull($N, $S)", java.util.Objects.class, p.java(), p.java());
    }
    CodeBlock.Builder req = CodeBlock.builder().add("$T request = $T.of($T.$L)", REQUEST, REQUEST, OPERATIONS, op.operationConstant);
    for (OperationPlanner.PathParam p : op.pathParams) {
      req.add("\n.path($S, $N)", p.wire(), p.java());
    }
    m.addStatement("$L", req.build());
    m.addStatement("return transport.follow$L(request, $L)", async ? "Async" : "", typeToken(op.response));
    return m.build();
  }

  /** The return type of an operation's method. */
  private TypeName returns(OperationPlanner.Op op, boolean async) {
    TypeName value;
    switch (op.responseKind) {
      case SSE:
        return async ? ParameterizedTypeName.get(PUBLISHER, op.response) : ParameterizedTypeName.get(EVENT_STREAM, op.response);
      case BINARY:
        value = ArrayTypeName.of(TypeName.BYTE);
        break;
      case EMPTY:
        value = async ? ClassName.get(Void.class) : TypeName.VOID;
        break;
      default:
        value = op.response;
    }
    return async ? ParameterizedTypeName.get(FUTURE, value) : value;
  }

  private List<MethodSpec> methods(OperationPlanner.Op op, boolean async) {
    List<MethodSpec> out = new ArrayList<>();
    boolean hasBody = op.body != null;
    boolean hasParams = op.paramsType != null;
    out.add(full(op, async));
    if (hasParams && op.paramsOptional) {
      out.add(overload(op, async, hasBody, false));
    }
    if (hasBody && !op.bodyRequired) {
      out.add(overload(op, async, false, hasParams));
      if (hasParams && op.paramsOptional) {
        out.add(overload(op, async, false, false));
      }
    }
    return out;
  }

  private CodeBlock javadoc(OperationPlanner.Op op, boolean withBody, boolean withParams) {
    CodeBlock.Builder doc = CodeBlock.builder();
    String summary = op.summary == null || op.summary.isBlank() ? op.id : op.summary.strip();
    doc.add("$L\n\n<p><code>$L $L</code> ({@code $L})", Docs.javadoc(summary.endsWith(".") ? summary : summary + "."), op.method, Docs.javadoc(op.path), op.id);
    String para = Docs.javadoc(Docs.firstParagraph(op.description));
    if (!para.isEmpty()) {
      doc.add("\n\n<p>$L", para);
    }
    doc.add("\n\n");
    for (OperationPlanner.PathParam p : op.pathParams) {
      String d = Docs.javadoc(p.description());
      doc.add("@param $L $L\n", p.java(), d.isEmpty() ? "the {@code " + p.wire() + "}" : d);
    }
    if (withBody) {
      String d = Docs.javadoc(op.bodyDescription);
      doc.add("@param body $L\n", d.isEmpty() ? "the request body" : d);
    }
    if (withParams) {
      doc.add("@param params the query and header parameters\n");
    }
    switch (op.responseKind) {
      case EMPTY:
        break;
      case SSE:
        doc.add("@return the events, as they come; the stream resumes after a dropped connection\n");
        break;
      case BINARY:
        doc.add("@return the bytes\n");
        break;
      default:
        doc.add("@return the answer\n");
    }
    doc.add("@throws $T when the API refuses the call or can't be reached\n", API_EXCEPTION);
    return doc.build();
  }

  /** The method with every argument. */
  private MethodSpec full(OperationPlanner.Op op, boolean async) {
    boolean hasBody = op.body != null;
    boolean hasParams = op.paramsType != null;
    MethodSpec.Builder m =
        MethodSpec.methodBuilder(op.name())
            .addModifiers(Modifier.PUBLIC)
            .returns(returns(op, async))
            .addJavadoc(javadoc(op, hasBody, hasParams));
    for (OperationPlanner.PathParam p : op.pathParams) {
      m.addParameter(p.type(), p.java());
    }
    if (hasBody) {
      TypeName bodyType = op.bodyRequired ? op.body : op.body.annotated(com.palantir.javapoet.AnnotationSpec.builder(ModelWriter.NULLABLE).build());
      if (op.body instanceof ArrayTypeName) {
        bodyType = op.body;
      }
      m.addParameter(ParameterSpec.builder(bodyType, "body").build());
    }
    if (hasParams) {
      m.addParameter(op.paramsType, "params");
    }
    for (OperationPlanner.PathParam p : op.pathParams) {
      m.addStatement("$T.requireNonNull($N, $S)", java.util.Objects.class, p.java(), p.java());
    }
    if (hasBody && op.bodyRequired) {
      m.addStatement("$T.requireNonNull(body, $S)", java.util.Objects.class, "body");
    }
    if (hasParams) {
      m.addStatement("$T.requireNonNull(params, $S)", java.util.Objects.class, "params");
      m.addStatement("params.validate()");
    }
    CodeBlock.Builder req = CodeBlock.builder().add("$T request = $T.of($T.$L)", REQUEST, REQUEST, OPERATIONS, op.operationConstant);
    for (OperationPlanner.PathParam p : op.pathParams) {
      req.add("\n.path($S, $N)", p.wire(), p.java());
    }
    for (OperationPlanner.OtherParam p : op.otherParams) {
      String method = "query".equals(p.in()) ? "query" : "header";
      if (p.segments()) {
        req.add(
            "\n.query($S, params.$N() == null ? null : params.$N().stream().map(step -> step.key() + $S + step.value()).toList())",
            p.wire(), p.java(), p.java(), ":");
      } else {
        req.add("\n.$L($S, params.$N())", method, p.wire(), p.java());
      }
    }
    if (hasBody) {
      if ("json".equals(op.bodyKind)) {
        req.add("\n.json(body)");
      } else {
        req.add("\n.multipart(body == null ? null : $L)", multipart(op));
      }
    }
    m.addStatement("$L", req.build());
    m.addStatement(call(op, async));
    return m.build();
  }

  /** The parts of a multipart body: binary members as files, the rest as text. */
  private CodeBlock multipart(OperationPlanner.Op op) {
    Ir.Decl d = op.body instanceof ClassName ? models.index.get(op.body) : null;
    if (!(d instanceof Ir.RecordDecl)) {
      throw new GenerationException(op.id + ": a multipart body must be an object");
    }
    CodeBlock.Builder b = CodeBlock.builder().add("new $T()", MULTIPART);
    for (Ir.Field f : ((Ir.RecordDecl) d).fields) {
      if (f.type instanceof ArrayTypeName) {
        b.add(".file($S, body.$N())", f.wire, f.java);
      } else if (f.type.equals(ModelPlanner.STRING) || f.type.isBoxedPrimitive() || f.type.toString().equals("java.util.UUID")) {
        b.add(".text($S, body.$N())", f.wire, f.java);
      } else {
        throw new GenerationException(op.id + ": multipart member " + f.wire + " of type " + f.type);
      }
    }
    return b.build();
  }

  private CodeBlock call(OperationPlanner.Op op, boolean async) {
    String suffix = async ? "Async" : "";
    switch (op.responseKind) {
      case EMPTY:
        return CodeBlock.of(async ? "return transport.empty$L(request)" : "transport.empty$L(request)", suffix);
      case BINARY:
        return CodeBlock.of("return transport.binary$L(request)", suffix);
      case SSE:
        return CodeBlock.of("return transport.stream$L(request, $L)", suffix, typeToken(op.response));
      default:
        if (op.byStatus != null) {
          CodeBlock.Builder map = CodeBlock.builder().add("$T.of(", Map.class);
          int i = 0;
          for (Map.Entry<Integer, TypeName> e : op.byStatus.entrySet()) {
            map.add(i++ == 0 ? "$L, $T.class" : ", $L, $T.class", e.getKey(), e.getValue());
          }
          map.add(")");
          return CodeBlock.of("return transport.byStatus$L(request, $T.class, $L)", suffix, op.response, map.build());
        }
        return CodeBlock.of("return transport.json$L(request, $L)", suffix, typeToken(op.response));
    }
  }

  /** {@code Run.class}, or a {@code TypeReference} for a generic type. */
  private static CodeBlock typeToken(TypeName t) {
    if (t instanceof ParameterizedTypeName) {
      return CodeBlock.of("new $T<$T>() {}", TYPE_REFERENCE, t);
    }
    return CodeBlock.of("$T.class", t);
  }

  /**
   * {@code <name>All}: every item of a cursor-paginated list, page after page; the next page is
   * fetched as the stream reaches it.
   */
  private MethodSpec autoPaging(OperationPlanner.Op op, boolean withParams) {
    String name = op.name() + "All";
    MethodSpec.Builder m =
        MethodSpec.methodBuilder(name)
            .addModifiers(Modifier.PUBLIC)
            .returns(ParameterizedTypeName.get(STREAM, op.pageItem))
            .addJavadoc(
                "Every item of {@code $L}, page after page: the next page is fetched as the stream reaches it. See"
                    + " {@link #$L}.\n\n",
                op.id,
                op.name());
    List<CodeBlock> pathArgs = new ArrayList<>();
    for (OperationPlanner.PathParam p : op.pathParams) {
      m.addParameter(p.type(), p.java());
      m.addJavadoc("@param $L $L\n", p.java(), Docs.javadoc(p.description()).isEmpty() ? "the {@code " + p.wire() + "}" : Docs.javadoc(p.description()));
      pathArgs.add(CodeBlock.of("$N", p.java()));
    }
    if (withParams) {
      m.addParameter(op.paramsType, "params");
      m.addJavadoc("@param params the query and header parameters ({@code cursor} is where the first page starts)\n");
    }
    m.addJavadoc("@return the items, lazily\n@throws $T when a page's call fails\n", API_EXCEPTION);
    if (!withParams) {
      List<CodeBlock> args = new ArrayList<>(pathArgs);
      args.add(CodeBlock.of("$T.builder().build()", op.paramsType));
      m.addStatement("return $N($L)", name, CodeBlock.join(args, ", "));
      return m.build();
    }
    m.addStatement("$T.requireNonNull(params, $S)", java.util.Objects.class, "params");
    List<CodeBlock> args = new ArrayList<>(pathArgs);
    args.add(CodeBlock.of("cursor == null ? params : params.toBuilder().cursor(cursor).build()"));
    m.addStatement(
        "return $T.stream(cursor -> $N($L), $T::data, $T::hasMore, $T::nextCursor)",
        PAGING, op.name(), CodeBlock.join(args, ", "), op.response, op.response, op.response);
    return m.build();
  }

  /** A shorter form that leaves out the body or the parameters (all optional). */
  private MethodSpec overload(OperationPlanner.Op op, boolean async, boolean withBody, boolean withParams) {
    MethodSpec.Builder m =
        MethodSpec.methodBuilder(op.name())
            .addModifiers(Modifier.PUBLIC)
            .returns(returns(op, async))
            .addJavadoc(javadoc(op, withBody, withParams));
    List<CodeBlock> args = new ArrayList<>();
    for (OperationPlanner.PathParam p : op.pathParams) {
      m.addParameter(p.type(), p.java());
      args.add(CodeBlock.of("$N", p.java()));
    }
    if (op.body != null) {
      if (withBody) {
        m.addParameter(op.body, "body");
        args.add(CodeBlock.of("body"));
      } else {
        args.add(CodeBlock.of("null"));
      }
    }
    if (op.paramsType != null) {
      if (withParams) {
        m.addParameter(op.paramsType, "params");
        args.add(CodeBlock.of("params"));
      } else {
        args.add(CodeBlock.of("$T.builder().build()", op.paramsType));
      }
    }
    CodeBlock call = CodeBlock.of("$N($L)", op.name(), CodeBlock.join(args, ", "));
    if (op.responseKind == OperationPlanner.ResponseKind.EMPTY && !async) {
      m.addStatement("$L", call);
    } else {
      m.addStatement("return $L", call);
    }
    return m.build();
  }
}
