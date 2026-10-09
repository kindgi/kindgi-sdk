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

// What Maven Central requires of every pom (sdks/java/pom.xml says the same).
ThisBuild / organizationName := "Kindgi Inc."
ThisBuild / organizationHomepage := Some(url("https://kindgi.com"))
ThisBuild / licenses := Seq("Apache-2.0" -> url("https://www.apache.org/licenses/LICENSE-2.0.txt"))
ThisBuild / homepage := Some(url("https://github.com/kindgi/kindgi-sdk/tree/main/sdks/scala"))
ThisBuild / scmInfo := Some(
  ScmInfo(
    url("https://github.com/kindgi/kindgi-sdk/tree/main/sdks/scala"),
    "scm:git:https://github.com/kindgi/kindgi-sdk.git"
  )
)
ThisBuild / developers := List(
  Developer("kindgi", "Kindgi Inc.", "", url("https://kindgi.com"))
)
// The local Maven repository resolves kindgi-pack in the build; the published pom names no repository.
ThisBuild / pomIncludeRepository := { _ => false }
// `publish` / `publishSigned` write to target/sona-staging, a Maven repository on disk:
// scripts/check-jars.mjs checks it, and scripts/central-bundle.mjs uploads it with the Java SDK's.
ThisBuild / publishTo := localStaging.value
// No versionScheme: in preview, a patch release may still change the API.

lazy val licenseFiles = settingKey[Seq[(File, String)]]("The repository's LICENSE and NOTICE, as jar entries")

lazy val root = (project in file("."))
  .aggregate(pack)
  .settings(publish / skip := true)

lazy val pack = (project in file("kindgi-pack-scala"))
  .settings(
    name := "kindgi-pack-scala",
    description := "Kindgi™ tools, guardrails, agents and flows in Scala, on kindgi-pack. In preview: tested and supported, but the API may still change in 0.1.6 without the usual deprecation period.",
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
    Test / fork := true,
    // The repository's LICENSE and NOTICE in the jar and the sources jar, as kindgi-pack's (never a copy).
    licenseFiles := {
      val repo = (ThisBuild / baseDirectory).value.getParentFile.getParentFile
      Seq(repo / "LICENSE" -> "META-INF/LICENSE", repo / "NOTICE" -> "META-INF/NOTICE")
    },
    Compile / packageBin / mappings ++= licenseFiles.value,
    Compile / packageSrc / mappings ++= licenseFiles.value
  )
