// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import com.kindgi.pack.spi.{SchemaProperty, SchemaType, SchemaTypeAdapter}
import java.{util => ju}
import java.util.Optional
import java.util.function.{Function => JFunction}
import scala.util.Try

/**
 * Teaches kindgi-pack's schema deriver Scala's types (found through {@code ServiceLoader}):
 *
 *  - {@code Option[T]}: not required, and {@code null} allowed;
 *  - {@code Seq}, {@code List}, {@code Vector} and other sequences: {@code array};
 *    {@code Set}: {@code array} with {@code uniqueItems};
 *  - {@code Map[String, T]}: {@code object} with {@code additionalProperties};
 *  - {@code BigDecimal}: {@code number}; {@code BigInt}: {@code integer};
 *  - a Scala 3 simple enum ({@code enum Color { case Red, Green }}): {@code string} of its case names;
 *  - a case class parameter's default: {@code default}, not required.
 *
 * Scala's primitives inside a type parameter ({@code Seq[Int]}, {@code Option[Long]}) are
 * {@code Object} on the JVM, so their schema there is any JSON value.
 */
final class ScalaTypeAdapter extends SchemaTypeAdapter {
  override def schema(t: SchemaType, derive: JFunction[SchemaType, ju.Map[String, AnyRef]]): ju.Map[String, AnyRef] = {
    val raw = t.rawClass
    if (classOf[scala.collection.Map[_, _]].isAssignableFrom(raw)) {
      val key = t.typeArgument(0).rawClass
      if (key != classOf[String] && key != classOf[AnyRef]) {
        throw new IllegalArgumentException(s"a map's keys must be strings, not ${key.getName}")
      }
      schemaOf("type" -> "object", "additionalProperties" -> derive.apply(t.typeArgument(1)))
    } else if (classOf[scala.collection.Set[_]].isAssignableFrom(raw)) {
      schemaOf("type" -> "array", "items" -> derive.apply(t.typeArgument(0)), "uniqueItems" -> java.lang.Boolean.TRUE)
    } else if (classOf[scala.collection.Iterable[_]].isAssignableFrom(raw)) {
      schemaOf("type" -> "array", "items" -> derive.apply(t.typeArgument(0)))
    } else if (raw == classOf[BigDecimal]) {
      schemaOf("type" -> "number")
    } else if (raw == classOf[BigInt]) {
      schemaOf("type" -> "integer")
    } else if (ScalaEnums.names(raw).isDefined) {
      schemaOf("type" -> "string", "enum" -> JsonValues.toJava(ScalaEnums.names(raw).get))
    } else {
      null
    }
  }

  override def optionalOf(t: SchemaType): SchemaType =
    if (classOf[Option[_]].isAssignableFrom(t.rawClass)) t.typeArgument(0) else null

  /** A case class parameter's default: its companion's {@code $lessinit$greater$default$N}, by position. */
  override def defaultValue(property: SchemaProperty): Optional[AnyRef] = {
    val owner = property.declaringType
    if (property.constructorIndex.isEmpty || !classOf[Product].isAssignableFrom(owner)) {
      Optional.empty()
    } else {
      val found = for {
        companion <- Try(Class.forName(owner.getName + "$", true, owner.getClassLoader)).toOption
        module <- Try(companion.getField("MODULE$").get(null)).toOption
        method <- Try(companion.getMethod("$lessinit$greater$default$" + (property.constructorIndex.getAsInt + 1))).toOption
      } yield method.invoke(module)
      Optional.ofNullable(found.orNull)
    }
  }

  private def schemaOf(entries: (String, AnyRef)*): ju.Map[String, AnyRef] = {
    val out = new ju.LinkedHashMap[String, AnyRef]()
    entries.foreach { case (k, v) => out.put(k, v) }
    out
  }
}
