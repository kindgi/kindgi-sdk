// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The conformance suite's invalid-flow pack in Scala, built as the fixture pack is
// (../scala-pack/build.sbt). `sbt writeClasspath` compiles it and writes target/classpath.txt and
// target/scala-version.txt, which tests/scala.test.ts reads. `sbt ++2.13.18! writeClasspath`
// builds it with Scala 2.13 instead.

lazy val kindgiPackScala = ProjectRef(file("../../../../sdks/scala"), "pack")

lazy val writeClasspath = taskKey[Unit]("Writes the runtime classpath for the conformance suite")

lazy val root = (project in file("."))
  .dependsOn(kindgiPackScala)
  .settings(
    name := "conformance-scala-invalid-flow-pack",
    scalaVersion := "3.3.8",
    externalResolvers := Resolver.mavenLocal +: externalResolvers.value,
    publish / skip := true,
    writeClasspath := {
      val classpath = (Runtime / fullClasspath).value.files.map(_.getAbsolutePath)
      IO.write(target.value / "classpath.txt", classpath.mkString(java.io.File.pathSeparator))
      IO.write(target.value / "scala-version.txt", scalaVersion.value)
    }
  )
