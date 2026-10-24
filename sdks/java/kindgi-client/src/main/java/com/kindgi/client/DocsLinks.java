// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * A docs page on a version's release line: {@code
 * docs.kindgi.com/v<major>.<minor>/<path>}, the line's latest release. The site's root moves on to
 * the next line's docs (and, during a release candidate, is still the last release's), so a link a
 * program shows names its own line: the CLI passes its version, a console the runtime's. Without a
 * version that is one (none, or a broken install's {@code unknown}), the root.
 *
 * <p>The Java counterpart of {@code docsUrl} in {@code @kindgi/client}. No dependencies: {@link
 * com.kindgi.client.sso.SsoHandoff} builds its guide links here.
 */
public final class DocsLinks {

  private static final String DOCS = "https://docs.kindgi.com";
  private static final Pattern RELEASE_LINE = Pattern.compile("^(\\d+)\\.(\\d+)\\.");

  private DocsLinks() {}

  /** A docs page at the site's root, with no release line. */
  public static String docsUrl(String path) {
    return docsUrl(path, null);
  }

  /**
   * A docs page on {@code version}'s release line, or the root when {@code version} is {@code null}
   * or isn't a version (a broken install's {@code unknown}).
   *
   * @param path the page under the docs root; a leading slash names the same page
   * @param version the version whose release line to link, or {@code null} for the root
   */
  public static String docsUrl(String path, @Nullable String version) {
    String page = path.replaceAll("^/+", "");
    if (version != null) {
      Matcher line = RELEASE_LINE.matcher(version);
      if (line.find()) {
        return DOCS + "/v" + line.group(1) + "." + line.group(2) + "/" + page;
      }
    }
    return DOCS + "/" + page;
  }
}
