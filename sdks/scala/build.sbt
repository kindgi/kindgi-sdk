// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// The Scala layer over kindgi-pack (sdks/java/kindgi-pack), cross-built for Scala 2.13 and the 3.3
// LTS line. Its version is the npm packages' (version.sbt, written by scripts/sync-jvm-version.mjs),
// and kindgi-pack's is the same.
//
// kindgi-pack isn't on Maven Central yet: install it first (sdks/java: ./mvnw -pl kindgi-pack -am
// install -DskipTests), and this build reads it from the local Maven repository.

val Scala213 = "2.13.18"
val Scala3 = "3.3.8"

// The oldest Jackson kindgi-pack supports; an app's newer one wins (see the README).
val JacksonVersion = "2.15.4"

ThisBuild / organization := "com.kindgi"
ThisBuild / scalaVersion := Scala3
ThisBuild / crossScalaVersions := Seq(Scala213, Scala3)
ThisBuild / resolvers += Resolver.mavenLocal
ThisBuild / licenses := Seq("Apache-2.0" -> url("https://www.apache.org/licenses/LICENSE-2.0"))
ThisBuild / homepage := Some(url("https://kindgi.com"))

lazy val root = (project in file("."))
  .aggregate(pack)
  .settings(publish / skip := true)

lazy val pack = (project in file("kindgi-pack-scala"))
  .settings(
    name := "kindgi-pack-scala",
    description := "Kindgi tools, guardrails, agents and flows in Scala, on kindgi-pack",
    javacOptions ++= Seq("--release", "17"),
    scalacOptions ++= {
      CrossVersion.partialVersion(scalaVersion.value) match {
        case Some((2, _)) => Seq("-release", "17", "-deprecation", "-feature", "-Xsource:3")
        case _            => Seq("-release", "17", "-deprecation", "-feature")
      }
    },
    libraryDependencies ++= Seq(
      "com.kindgi" % "kindgi-pack" % version.value,
      "com.fasterxml.jackson.module" %% "jackson-module-scala" % JacksonVersion,
      "org.scalameta" %% "munit" % "1.3.6" % Test,
      "jakarta.validation" % "jakarta.validation-api" % "3.0.2" % Test
    ),
    Test / fork := true
  )
