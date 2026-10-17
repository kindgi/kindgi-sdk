// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.codegen;

import java.io.File;
import org.apache.maven.plugin.AbstractMojo;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.project.MavenProject;

/** Generates the Java client's sources from the API document and adds them to the build. */
@Mojo(name = "generate", defaultPhase = LifecyclePhase.GENERATE_SOURCES, threadSafe = true)
public final class GenerateMojo extends AbstractMojo {
  /** The Kindgi API's OpenAPI document. */
  @Parameter(property = "kindgi.openapi", required = true)
  private File openapi;

  /** Which artifact: {@code models} (kindgi-models) or {@code client} (kindgi-client). */
  @Parameter(property = "kindgi.target", required = true)
  private String target;

  /** Where the generated sources go. */
  @Parameter(defaultValue = "${project.build.directory}/generated-sources/kindgi", required = true)
  private File outputDirectory;

  @Parameter(defaultValue = "${project}", readonly = true, required = true)
  private MavenProject project;

  /** For Maven. */
  public GenerateMojo() {}

  @Override
  public void execute() throws MojoExecutionException {
    if (!openapi.isFile()) {
      throw new MojoExecutionException("The API document isn't there: " + openapi);
    }
    try {
      Generator.Target t;
      try {
        t = Generator.Target.valueOf(target.toUpperCase(java.util.Locale.ROOT));
      } catch (IllegalArgumentException e) {
        throw new MojoExecutionException("target must be models or client, not " + target);
      }
      Generator.Result r = Generator.generate(openapi.toPath(), outputDirectory.toPath(), t);
      getLog().info(
              "Kindgi " + target + ": " + r.operations() + " operations, " + r.types() + " types, " + r.files()
                  + " files (" + r.written() + " written, " + r.deleted() + " removed)");
    } catch (GenerationException e) {
      throw new MojoExecutionException("Can't generate the Java client from " + openapi + ": " + e.getMessage(), e);
    }
    project.addCompileSourceRoot(outputDirectory.getPath());
  }
}
