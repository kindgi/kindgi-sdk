// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._

object ProcessEnv {
  val tool: Tool[Map[String, Any], Any] = Tool.json("conformance.process-env")
    .description("Returns the names of the KINDGI_ variables in its process environment.")
    .handler((_, _) => Map("names" -> sys.env.keys.filter(_.startsWith("KINDGI_")).toList.sorted))
}
