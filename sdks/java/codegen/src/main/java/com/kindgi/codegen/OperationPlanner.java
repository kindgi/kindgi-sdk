// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import com.palantir.javapoet.ArrayTypeName;
import com.palantir.javapoet.ClassName;
import com.palantir.javapoet.ParameterizedTypeName;
import com.palantir.javapoet.TypeName;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plans the client's operations: one method per operation of the API, on a resource tree that
 * follows the operation ids ({@code approvals.reviewers.list} is {@code
 * client.approvals().reviewers().list(…)}), as the TypeScript and Python clients do.
 */
final class OperationPlanner {
  static final String RESOURCES = "com.kindgi.client.resources";
  /** HTTP methods with a client method. `HEAD` has none, as in the Python client. */
  static final List<String> METHODS = List.of("get", "post", "put", "patch", "delete");
  static final Set<String> SKIPPED_METHODS = Set.of("head");
  private static final Set<String> PATH_ITEM_KEYS =
      Set.of("get", "post", "put", "patch", "delete", "head", "parameters", "summary", "description");
  private static final Set<String> OPERATION_KEYS =
      Set.of("operationId", "summary", "description", "tags", "parameters", "requestBody", "responses", "security");
  private static final Set<String> PARAMETER_KEYS =
      Set.of("name", "in", "schema", "required", "description", "x-kindgi-segment-path");

  /**
   * More names for an operation, beside its own: the name the other resources use for the same
   * call ({@code evalSuites.unregister}, as {@code agents.unregister}). The Python client has the
   * same list.
   */
  static final Map<String, List<String>> ALIASES = Map.of("evalSuites.versions.unregister", List.of("evalSuites.unregister"));

  enum ResponseKind {
    JSON,
    SSE,
    BINARY,
    EMPTY
  }

  /** A path parameter: a positional argument. */
  record PathParam(String wire, String java, TypeName type, String description) {}

  /** A query or header parameter: a member of the operation's parameters record. */
  record OtherParam(String wire, String java, String in, boolean required, boolean segments, TypeName type) {}

  static final class Op {
    String id;
    String method;
    String path;
    String summary;
    String description;
    final List<PathParam> pathParams = new ArrayList<>();
    final List<OtherParam> otherParams = new ArrayList<>();
    ClassName paramsType;
    boolean paramsOptional;
    TypeName body;
    /** `json` or `multipart`. */
    String bodyKind;
    boolean bodyRequired;
    String bodyDescription;
    Ir.RecordDecl multipartBody;
    TypeName response;
    ResponseKind responseKind = ResponseKind.EMPTY;
    /** A response whose shape depends on the status: status → type. */
    Map<Integer, TypeName> byStatus;
    boolean idempotencyKey;
    String operationConstant;
    /** A cursor-paginated list: the item type of the page's {@code data} (else {@code null}). */
    TypeName pageItem;

    List<String> resource() {
      String[] parts = id.split("\\.");
      return List.of(parts).subList(0, parts.length - 1);
    }

    String name() {
      String[] parts = id.split("\\.");
      return Names.camel(parts[parts.length - 1]);
    }
  }

  /** A node of the resource tree. */
  static final class Resource {
    final List<String> path;
    final List<Op> ops = new ArrayList<>();
    final Map<String, Resource> children = new LinkedHashMap<>();

    Resource(List<String> path) {
      this.path = path;
    }

    String simpleName(boolean async) {
      StringBuilder sb = new StringBuilder(async ? "Async" : "");
      for (String p : path) {
        sb.append(Names.pascal(p));
      }
      return sb.append("Resource").toString();
    }

    ClassName className(boolean async) {
      return ClassName.get(RESOURCES, simpleName(async));
    }
  }

  private final Map<String, Object> document;
  private final ModelPlanner models;
  final List<Op> ops = new ArrayList<>();
  final Resource root = new Resource(List.of());
  /** Every operation id, aliases excluded, and those without a method (`HEAD`). */
  final Set<String> skipped = new LinkedHashSet<>();

  OperationPlanner(Map<String, Object> document, ModelPlanner models) {
    this.document = document;
    this.models = models;
    for (Map.Entry<String, Map<String, Object>> op : rawOperations().entrySet()) {
      for (Schema s : operationSchemas(op.getValue(), op.getKey())) {
        models.noteOperationSchema(s);
      }
    }
  }

  /** "METHOD path" → the operation object, in document order. */
  private Map<String, Map<String, Object>> rawOperations() {
    Map<String, Map<String, Object>> out = new LinkedHashMap<>();
    Map<String, Object> paths = map(document.get("paths"), "paths");
    for (Map.Entry<String, Object> pe : paths.entrySet()) {
      Map<String, Object> item = map(pe.getValue(), pe.getKey());
      for (String key : item.keySet()) {
        if (!PATH_ITEM_KEYS.contains(key)) {
          throw new GenerationException(pe.getKey() + ": unsupported path item key " + key);
        }
      }
      for (String method : List.of("get", "post", "put", "patch", "delete", "head")) {
        if (item.containsKey(method)) {
          out.put(method.toUpperCase() + " " + pe.getKey(), map(item.get(method), pe.getKey() + " " + method));
        }
      }
    }
    return out;
  }

  private List<Schema> operationSchemas(Map<String, Object> op, String where) {
    List<Schema> out = new ArrayList<>();
    for (Object p : list(op.get("parameters"))) {
      Map<String, Object> pm = map(p, where);
      if (pm.containsKey("schema")) {
        out.add(Schema.of(pm.get("schema"), where + " parameter " + pm.get("name")));
      }
    }
    Object body = op.get("requestBody");
    if (body != null) {
      for (Map.Entry<String, Object> c : map(map(body, where).get("content"), where).entrySet()) {
        out.add(Schema.of(map(c.getValue(), where).get("schema"), where + " body " + c.getKey()));
      }
    }
    for (Map.Entry<String, Object> r : map(op.get("responses"), where).entrySet()) {
      Object content = map(r.getValue(), where).get("content");
      if (content != null) {
        for (Map.Entry<String, Object> c : map(content, where).entrySet()) {
          Object schema = map(c.getValue(), where).get("schema");
          if (schema != null) {
            out.add(Schema.of(schema, where + " response " + r.getKey() + " " + c.getKey()));
          }
        }
      }
    }
    return out;
  }

  void plan() {
    Map<String, Object> paths = map(document.get("paths"), "paths");
    Set<String> ids = new LinkedHashSet<>();
    for (Map.Entry<String, Object> pe : paths.entrySet()) {
      String path = pe.getKey();
      Map<String, Object> item = map(pe.getValue(), path);
      if (item.containsKey("parameters")) {
        throw new GenerationException(path + ": path-level parameters aren't supported");
      }
      for (String method : List.of("get", "post", "put", "patch", "delete", "head")) {
        if (!item.containsKey(method)) {
          continue;
        }
        Map<String, Object> raw = map(item.get(method), path + " " + method);
        String id = (String) raw.get("operationId");
        if (id == null || !ids.add(id)) {
          throw new GenerationException(path + " " + method + ": missing or duplicate operationId " + id);
        }
        if (SKIPPED_METHODS.contains(method)) {
          skipped.add(id);
          continue;
        }
        Op op = planOp(id, method.toUpperCase(), path, raw);
        ops.add(op);
        for (String alias : ALIASES.getOrDefault(id, List.of())) {
          Op copy = planAlias(op, alias);
          ops.add(copy);
        }
      }
    }
    for (Op op : ops) {
      Resource node = root;
      List<String> segs = op.resource();
      for (int i = 0; i < segs.size(); i++) {
        List<String> prefix = segs.subList(0, i + 1);
        node = node.children.computeIfAbsent(segs.get(i), k -> new Resource(List.copyOf(prefix)));
      }
      node.ops.add(op);
    }
    for (Op op : ops) {
      op.pageItem = pageItem(op);
    }
    checkNames(root);
  }

  /**
   * The item type when the operation is a cursor-paginated list: a {@code cursor} query parameter,
   * and an answer with {@code data} (a list), {@code hasMore} and {@code nextCursor}.
   */
  private TypeName pageItem(Op op) {
    if (op.responseKind != ResponseKind.JSON || op.byStatus != null || !(op.response instanceof ClassName)) {
      return null;
    }
    boolean cursor = op.otherParams.stream().anyMatch(p -> p.wire().equals("cursor") && p.in().equals("query"));
    Ir.Decl d = models.index.get(op.response);
    if (!cursor || !(d instanceof Ir.RecordDecl)) {
      return null;
    }
    Map<String, Ir.Field> fields = new LinkedHashMap<>();
    for (Ir.Field f : ((Ir.RecordDecl) d).fields) {
      fields.put(f.wire, f);
    }
    Ir.Field data = fields.get("data");
    if (data == null || !fields.containsKey("hasMore") || !fields.containsKey("nextCursor")
        || !(data.type instanceof ParameterizedTypeName)
        || !((ParameterizedTypeName) data.type).rawType().equals(ModelPlanner.LIST)) {
      return null;
    }
    return ((ParameterizedTypeName) data.type).typeArguments().get(0);
  }

  private Op planAlias(Op op, String alias) {
    Op copy = new Op();
    copy.id = alias;
    copy.method = op.method;
    copy.path = op.path;
    copy.summary = op.summary;
    copy.description = op.description;
    copy.pathParams.addAll(op.pathParams);
    copy.otherParams.addAll(op.otherParams);
    copy.paramsType = op.paramsType;
    copy.paramsOptional = op.paramsOptional;
    copy.body = op.body;
    copy.bodyKind = op.bodyKind;
    copy.bodyRequired = op.bodyRequired;
    copy.bodyDescription = op.bodyDescription;
    copy.multipartBody = op.multipartBody;
    copy.response = op.response;
    copy.responseKind = op.responseKind;
    copy.byStatus = op.byStatus;
    copy.idempotencyKey = op.idempotencyKey;
    copy.operationConstant = op.operationConstant;
    copy.pageItem = op.pageItem;
    return copy;
  }

  private Op planOp(String id, String method, String path, Map<String, Object> raw) {
    for (String key : raw.keySet()) {
      if (!OPERATION_KEYS.contains(key)) {
        throw new GenerationException(id + ": unsupported operation key " + key);
      }
    }
    Op op = new Op();
    op.id = id;
    op.method = method;
    op.path = path;
    op.summary = (String) raw.getOrDefault("summary", "");
    op.description = (String) raw.getOrDefault("description", "");
    op.operationConstant = Names.constant(id);
    String hint = Names.pascal(id);

    List<String> order = new ArrayList<>();
    Matcher m = Pattern.compile("\\{([^}]+)}").matcher(path);
    while (m.find()) {
      order.add(m.group(1));
    }
    Map<String, PathParam> byName = new LinkedHashMap<>();
    List<ModelPlanner.ParamSpec> others = new ArrayList<>();
    List<OtherParam> otherParams = new ArrayList<>();
    Set<String> javaNames = new LinkedHashSet<>();
    for (Object p : list(raw.get("parameters"))) {
      Map<String, Object> pm = map(p, id);
      for (String key : pm.keySet()) {
        if (!PARAMETER_KEYS.contains(key)) {
          throw new GenerationException(id + ": unsupported parameter key " + key);
        }
      }
      String name = (String) pm.get("name");
      String in = (String) pm.get("in");
      Schema schema = Schema.of(pm.get("schema"), id + " parameter " + name);
      boolean required = Boolean.TRUE.equals(pm.get("required"));
      String description = (String) pm.get("description");
      String java = javaParamName(name);
      if (!javaNames.add(java)) {
        throw new GenerationException(id + ": two parameters become " + java);
      }
      switch (in) {
        case "path":
          if (!required) {
            throw new GenerationException(id + ": optional path parameter " + name);
          }
          TypeName type = models.typeOf(schema, models.top(), hint + Names.pascal(name));
          byName.put(name, new PathParam(name, java, type, description));
          break;
        case "query":
        case "header":
          boolean segments = Boolean.TRUE.equals(pm.get("x-kindgi-segment-path"));
          TypeName fixed = null;
          if (segments) {
            if (!"query".equals(in)) {
              throw new GenerationException(id + ": a segment path outside the query");
            }
            fixed = ParameterizedTypeName.get(ModelPlanner.LIST, segmentType());
            java = "segments";
          }
          others.add(new ModelPlanner.ParamSpec(name, java, schema, required, description, fixed));
          otherParams.add(new OtherParam(name, java, in, required, segments, null));
          if ("header".equals(in) && name.equals("Idempotency-Key")) {
            op.idempotencyKey = true;
          }
          break;
        default:
          throw new GenerationException(id + ": unsupported parameter location " + in);
      }
    }
    for (String name : order) {
      PathParam pp = byName.remove(name);
      if (pp == null) {
        throw new GenerationException(id + ": path parameter {" + name + "} isn't declared");
      }
      op.pathParams.add(pp);
    }
    if (!byName.isEmpty()) {
      throw new GenerationException(id + ": path parameters not in the path: " + byName.keySet());
    }
    if (!others.isEmpty()) {
      ClassName cn = ClassName.get(RESOURCES, hint + "Params");
      Ir.RecordDecl d =
          models.planParams(cn, "The query and header parameters of {@code " + id + "}.", others);
      op.paramsType = cn;
      op.paramsOptional = others.stream().noneMatch(ModelPlanner.ParamSpec::required);
      for (int i = 0; i < otherParams.size(); i++) {
        OtherParam o = otherParams.get(i);
        op.otherParams.add(new OtherParam(o.wire(), o.java(), o.in(), o.required(), o.segments(), d.fields.get(i).type));
      }
    }

    Object body = raw.get("requestBody");
    if (body != null) {
      Map<String, Object> bm = map(body, id);
      op.bodyRequired = Boolean.TRUE.equals(bm.get("required"));
      op.bodyDescription = (String) bm.get("description");
      Map<String, Object> content = map(bm.get("content"), id);
      if (content.size() != 1) {
        throw new GenerationException(id + ": a request body with " + content.size() + " media types");
      }
      String media = content.keySet().iterator().next();
      Schema schema = Schema.of(map(content.get(media), id).get("schema"), id + " body");
      if (media.equals("application/json")) {
        op.bodyKind = "json";
        op.body = models.typeOf(schema, models.top(), hint + "Body");
      } else if (media.equals("multipart/form-data")) {
        op.bodyKind = "multipart";
        op.body = models.typeOf(schema, models.top(), hint + "Body");
      } else {
        throw new GenerationException(id + ": unsupported request media type " + media);
      }
    }

    Map<String, Object> responses = map(raw.get("responses"), id);
    Map<Integer, TypeName> success = new TreeMap<>();
    ResponseKind kind = null;
    for (Map.Entry<String, Object> r : responses.entrySet()) {
      if (!r.getKey().startsWith("2")) {
        continue;
      }
      int status = Integer.parseInt(r.getKey());
      Object content = map(r.getValue(), id).get("content");
      ResponseKind k;
      TypeName t = null;
      if (content == null || map(content, id).isEmpty()) {
        k = ResponseKind.EMPTY;
      } else {
        Map<String, Object> cm = map(content, id);
        if (cm.size() != 1) {
          throw new GenerationException(id + ": a " + status + " response with " + cm.size() + " media types");
        }
        String media = cm.keySet().iterator().next();
        Object rawSchema = map(cm.get(media), id).get("schema");
        switch (media) {
          case "application/json":
            k = ResponseKind.JSON;
            t = models.typeOf(Schema.of(rawSchema, id + " response"), models.top(), hint + "Response");
            break;
          case "text/event-stream":
            k = ResponseKind.SSE;
            t = models.typeOf(Schema.of(rawSchema, id + " events"), models.top(), hint + "Event");
            break;
          case "application/octet-stream":
            k = ResponseKind.BINARY;
            t = ArrayTypeName.of(TypeName.BYTE);
            break;
          default:
            throw new GenerationException(id + ": unsupported response media type " + media);
        }
      }
      if (kind != null && kind != k) {
        throw new GenerationException(id + ": 2xx responses of different kinds");
      }
      kind = k;
      if (t != null) {
        success.put(status, t);
      }
    }
    op.responseKind = kind == null ? ResponseKind.EMPTY : kind;
    Set<TypeName> distinct = new LinkedHashSet<>(success.values());
    if (distinct.size() == 1) {
      op.response = distinct.iterator().next();
    } else if (distinct.size() > 1) {
      if (op.responseKind != ResponseKind.JSON) {
        throw new GenerationException(id + ": different 2xx shapes that aren't JSON");
      }
      List<ClassName> variants = new ArrayList<>();
      for (TypeName t : distinct) {
        if (!(t instanceof ClassName)) {
          throw new GenerationException(id + ": a 2xx shape that isn't a named type");
        }
        variants.add((ClassName) t);
      }
      op.response = models.statusUnion(hint + "Response", "The answer of {@code " + id + "}, by HTTP status.", variants);
      op.byStatus = success;
    }
    return op;
  }

  /** The segment-path step type, {@code ScopeSegment}: `key` and `value`, as the query writes them. */
  private TypeName segmentType() {
    TypeName t = models.componentType("ScopeSegment");
    Schema s = models.component("ScopeSegment");
    if (!(t instanceof ClassName) || !s.properties().containsKey("key") || !s.properties().containsKey("value")) {
      throw new GenerationException("ScopeSegment must be an object with key and value");
    }
    return t;
  }

  /** `Idempotency-Key` → `idempotencyKey`; `X-Supervisor-Id` → `supervisorId`. */
  static String javaParamName(String wire) {
    String name = wire.startsWith("X-") || wire.startsWith("x-") ? wire.substring(2) : wire;
    return Names.member(name);
  }

  private void checkNames(Resource node) {
    Set<String> zeroArg = new LinkedHashSet<>();
    Set<String> methodNames = new LinkedHashSet<>();
    for (Op op : node.ops) {
      methodNames.add(op.name());
    }
    for (Op op : node.ops) {
      if (op.pageItem != null && methodNames.contains(op.name() + "All")) {
        throw new GenerationException(op.id + ": its auto-paging method " + op.name() + "All clashes with an operation");
      }
      boolean canBeNullary =
          op.pathParams.isEmpty() && (op.body == null || !op.bodyRequired) && (op.paramsType == null || op.paramsOptional);
      if (canBeNullary) {
        zeroArg.add(op.name());
      }
    }
    for (String child : node.children.keySet()) {
      String accessor = Names.camel(child);
      if (zeroArg.contains(accessor)) {
        throw new GenerationException(
            String.join(".", node.path) + ": the resource " + child + " and an operation share the name " + accessor);
      }
    }
    for (Resource child : node.children.values()) {
      checkNames(child);
    }
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object v, String where) {
    if (!(v instanceof Map)) {
      throw new GenerationException(where + ": expected an object");
    }
    return (Map<String, Object>) v;
  }

  private static List<?> list(Object v) {
    return v == null ? List.of() : (List<?>) v;
  }
}
