// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import java.{util => ju}
import scala.jdk.CollectionConverters._

/**
 * A record's fields, from Scala's values to the Java ones the logger reads: maps, sequences,
 * options, BigDecimal and BigInt, and a case class as an object of its fields (so a secret-looking
 * field is redacted by its name, as a Java record's is). Lenient, as logging must be: a key is its
 * text, and anything deeper than a few levels is passed on as it is.
 */
private[scaladsl] object LogValues {
  private val MaxDepth = 8

  def fields(pairs: Iterable[(String, Any)]): ju.Map[String, AnyRef] = {
    val out = new ju.LinkedHashMap[String, AnyRef]()
    pairs.foreach { case (k, v) => out.put(k, value(v, 0)) }
    out
  }

  private def value(v: Any, depth: Int): AnyRef = v match {
    case null => null
    case _ if depth >= MaxDepth => v.asInstanceOf[AnyRef]
    case m: scala.collection.Map[_, _] =>
      val out = new ju.LinkedHashMap[String, AnyRef]()
      m.foreach { case (k, x) => out.put(String.valueOf(k), value(x, depth + 1)) }
      out
    case o: Option[_] => o.map(value(_, depth)).orNull
    case s: scala.collection.Iterable[_] => new ju.ArrayList[AnyRef](s.map(value(_, depth + 1)).toSeq.asJava)
    case a: Array[_] => new ju.ArrayList[AnyRef](a.toSeq.map(value(_, depth + 1)).asJava)
    case d: BigDecimal => d.bigDecimal
    case i: BigInt => i.bigInteger
    case _: Throwable => v.asInstanceOf[AnyRef]
    case p: Product if p.productArity > 0 && p.productPrefix.startsWith("Tuple") =>
      new ju.ArrayList[AnyRef](p.productIterator.map(value(_, depth + 1)).toSeq.asJava)
    case p: Product if p.productArity > 0 =>
      val out = new ju.LinkedHashMap[String, AnyRef]()
      p.productElementNames.zip(p.productIterator).foreach { case (k, x) => out.put(k, value(x, depth + 1)) }
      out
    case other => other.asInstanceOf[AnyRef]
  }
}
