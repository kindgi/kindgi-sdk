// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package scalapack.tools

import com.kindgi.pack.scaladsl._

/** A tool as a def: the indexer can't read it without running it, and says so. */
object Lazy {
  def tool: Tool[Map[String, Any], Any] = Tool.json("acme.lazy").handler((in, _) => in)
}
