// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client.sso;

import java.util.Objects;
import java.util.Optional;

/**
 * What {@link SsoHandoff#forProvider} produces for a provider's URLs: the message for whoever runs
 * the identity provider, that provider's console steps when there are some, and the step-by-step
 * guide's URL.
 *
 * <p>The Java counterpart of {@code IdentityProviderHandoff} in {@code @kindgi/client/sso-handoff}.
 * The message's lines are joined with {@code \n}, with no trailing newline.
 *
 * @param message the message for whoever runs the identity provider: the URLs and what to send back
 * @param steps the steps in that identity provider's console, present only with a preset
 * @param guideUrl the step-by-step guide, on the release line of the version passed (see {@link
 *     com.kindgi.client.DocsLinks})
 */
public record IdentityProviderHandoff(String message, Optional<String> steps, String guideUrl) {
  public IdentityProviderHandoff {
    Objects.requireNonNull(message, "message");
    Objects.requireNonNull(steps, "steps");
    Objects.requireNonNull(guideUrl, "guideUrl");
  }
}
