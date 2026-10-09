// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

// Signs what `publishSigned` stages for Maven Central (.github/workflows/release.yml), with the key in
// GNUPGHOME's keyring and the passphrase from PGP_PASSPHRASE.
addSbtPlugin("com.github.sbt" % "sbt-pgp" % "2.3.2")
