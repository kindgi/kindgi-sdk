// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack.scaladsl

import com.fasterxml.jackson.core.{JsonGenerator, JsonParser, JsonToken, Version}
import com.fasterxml.jackson.databind.{
  BeanDescription, DeserializationConfig, DeserializationContext, JavaType, JsonDeserializer, JsonSerializer,
  Module, SerializationConfig, SerializerProvider
}
import com.fasterxml.jackson.databind.deser.Deserializers
import com.fasterxml.jackson.databind.ser.Serializers
import java.lang.reflect.{Method, Modifier}
import scala.util.Try

/**
 * Scala 3's simple enums (`enum Color { case Red, Green `}): a string, the case's name. Found
 * by reflection, so this compiles and does nothing on Scala 2.13. An enum whose cases take
 * parameters isn't a simple one; it's a sealed hierarchy, which `@JsonTypeInfo` describes.
 */
private[scaladsl] object ScalaEnums {
  private val enumClass: Option[Class[_]] = Try(Class.forName("scala.reflect.Enum")).toOption

  /** The enum's `values()`, when the class is a simple Scala 3 enum. */
  def valuesMethod(cls: Class[_]): Option[Method] =
    enumClass.filter(_.isAssignableFrom(cls)).flatMap { _ =>
      Try(cls.getMethod("values")).toOption.filter(m => Modifier.isStatic(m.getModifiers) && m.getReturnType.isArray)
    }

  /** The case names, in order. */
  def names(cls: Class[_]): Option[Seq[String]] =
    valuesMethod(cls).map(_.invoke(null).asInstanceOf[Array[AnyRef]].toSeq.map(_.toString))

  /** The enum class a value's case belongs to: the class whose `values()` lists it. */
  def isSimple(cls: Class[_]): Boolean =
    valuesMethod(cls).isDefined || Option(cls.getSuperclass).exists(s => valuesMethod(s).isDefined)
}

/** Reads and writes Scala 3's simple enums by name; found by Jackson through `ServiceLoader`. */
final class ScalaEnumModule extends Module {
  override def getModuleName: String = "kindgi-scala-enums"

  override def version(): Version = Version.unknownVersion()

  /**
   * jackson-module-scala reads Scala 3 enums too (its `EnumModule`, in 2.18), but an unknown name
   * gets only "Failed to create Enum instance". Jackson asks the last registered module first and
   * registers a module's dependencies before it, so naming the Scala module here makes this one
   * answer, with the known cases, whichever order `ServiceLoader` finds them in. It's the class
   * `ServiceLoader` makes (not the Scala object, whose class name ends in `$`), so a later
   * registration of it is the duplicate Jackson ignores.
   */
  override def getDependencies: java.lang.Iterable[_ <: Module] =
    java.util.Collections.singletonList[Module](new com.fasterxml.jackson.module.scala.DefaultScalaModule())

  override def setupModule(context: Module.SetupContext): Unit = {
    context.addSerializers(new Serializers.Base {
      override def findSerializer(config: SerializationConfig, t: JavaType, bean: BeanDescription): JsonSerializer[_] =
        if (ScalaEnums.isSimple(t.getRawClass)) ScalaEnumModule.Writer else null
    })
    context.addDeserializers(new Deserializers.Base {
      override def findBeanDeserializer(t: JavaType, config: DeserializationConfig, bean: BeanDescription): JsonDeserializer[_] =
        ScalaEnums.valuesMethod(t.getRawClass).map(_ => new ScalaEnumModule.Reader(t.getRawClass)).orNull
    })
  }
}

private object ScalaEnumModule {
  object Writer extends JsonSerializer[AnyRef] {
    override def serialize(value: AnyRef, gen: JsonGenerator, provider: SerializerProvider): Unit =
      gen.writeString(value.toString)
  }

  final class Reader(cls: Class[_]) extends JsonDeserializer[AnyRef] {
    private val valueOf = cls.getMethod("valueOf", classOf[String])

    override def deserialize(p: JsonParser, ctxt: DeserializationContext): AnyRef = {
      if (p.currentToken() != JsonToken.VALUE_STRING) {
        ctxt.handleUnexpectedToken(cls, p).asInstanceOf[AnyRef]
      } else {
        val name = p.getText
        Try(valueOf.invoke(null, name)).getOrElse {
          ctxt.handleWeirdStringValue(cls, name,
            s"not one of ${ScalaEnums.names(cls).getOrElse(Nil).mkString(", ")}").asInstanceOf[AnyRef]
        }
      }
    }
  }
}
