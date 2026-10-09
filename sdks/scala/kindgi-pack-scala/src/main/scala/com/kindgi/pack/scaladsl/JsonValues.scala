// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import java.{util => ju}
import scala.jdk.CollectionConverters._

/**
 * Plain JSON values, between Scala's collections and the Java ones kindgi-pack takes: a schema, a
 * capability, a flow node, a json tool's input.
 */
private[scaladsl] object JsonValues {
  /** A Scala value as Java's: maps (string keys), sequences, options, BigDecimal and BigInt converted, deeply. */
  def toJava(value: Any): AnyRef = value match {
    case null => null
    case m: scala.collection.Map[_, _] =>
      val out = new ju.LinkedHashMap[String, AnyRef]()
      m.foreach { case (k, v) =>
        k match {
          case key: String => out.put(key, toJava(v))
          case other => throw new IllegalArgumentException(s"a JSON object's keys are strings, not $other")
        }
      }
      out
    case o: Option[_] => o.map(toJava).orNull
    case s: scala.collection.Iterable[_] => new ju.ArrayList[AnyRef](s.map(toJava).toSeq.asJava)
    case a: Array[_] => new ju.ArrayList[AnyRef](a.toSeq.map(toJava).asJava)
    case d: BigDecimal => d.bigDecimal
    case i: BigInt => i.bigInteger
    case other => other.asInstanceOf[AnyRef]
  }

  /** A JSON object as Java's. */
  def javaMap(value: Map[String, Any]): ju.Map[String, AnyRef] =
    toJava(value).asInstanceOf[ju.Map[String, AnyRef]]

  /** A Java value as Scala's: maps (in order) and lists converted, deeply. */
  def toScala(value: Any): Any = value match {
    case m: ju.Map[_, _] =>
      scala.collection.immutable.ListMap.from(m.asScala.iterator.map { case (k, v) => String.valueOf(k) -> toScala(v) })
    case l: ju.List[_] => l.asScala.iterator.map(toScala).toVector
    case other => other
  }

  /** A JSON object as Scala's. */
  def scalaMap(value: AnyRef): Map[String, Any] = toScala(value).asInstanceOf[Map[String, Any]]
}
