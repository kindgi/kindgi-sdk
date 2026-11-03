// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/** Mirrors the TypeScript {@code docs-links.test.ts}: a docs page on a version's release line. */
final class DocsLinksTest {

  private static final String PAGE = "guides/sso/oidc/";

  @Test
  void aVersionLinksItsReleaseLine() {
    assertEquals("https://docs.kindgi.com/v0.1/guides/sso/oidc/", DocsLinks.docsUrl(PAGE, "0.1.5"));
    assertEquals(
        "https://docs.kindgi.com/v0.1/guides/sso/oidc/", DocsLinks.docsUrl(PAGE, "0.1.6-rc.1"));
    assertEquals(
        "https://docs.kindgi.com/v0.1/guides/sso/oidc/", DocsLinks.docsUrl(PAGE, "0.1.5.1"));
    assertEquals("https://docs.kindgi.com/v0.2/guides/sso/oidc/", DocsLinks.docsUrl(PAGE, "0.2.0"));
    assertEquals(
        "https://docs.kindgi.com/v1.12/guides/sso/oidc/", DocsLinks.docsUrl(PAGE, "1.12.3"));
  }

  @Test
  void aLeadingSlashNamesTheSamePage() {
    assertEquals(DocsLinks.docsUrl(PAGE, "0.1.5"), DocsLinks.docsUrl("/" + PAGE, "0.1.5"));
  }

  @Test
  void noVersionOrOneThatIsntLinksTheRoot() {
    assertEquals("https://docs.kindgi.com/guides/sso/oidc/", DocsLinks.docsUrl(PAGE));
    assertEquals("https://docs.kindgi.com/guides/sso/oidc/", DocsLinks.docsUrl(PAGE, "unknown"));
  }
}
