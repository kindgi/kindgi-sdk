// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package conformance.tools

import com.kindgi.pack.scaladsl._
import scala.collection.immutable.ListMap
import scala.jdk.CollectionConverters._

object Context {
  val tool: Tool[Map[String, Any], Any] = Tool.json("conformance.context")
    .description("Returns the call context it received.")
    .handler { (_, ctx) =>
      ListMap[String, Any](
        "tenantId" -> ctx.tenantId,
        "runId" -> ctx.runId,
        "env" -> ctx.env,
        "secrets" -> ctx.secrets,
        "config" -> ctx.config) ++
        Option(ctx.requestId).map("requestId" -> _) ++
        Option(ctx.idempotencyKey).map("idempotencyKey" -> _) ++
        Option(ctx.projectId).map("projectId" -> _) ++
        Option(ctx.orgId).map("orgId" -> _) ++
        Option(ctx.settings).filterNot(_.isEmpty).map("settings" -> _) ++
        Option(ctx.connections).filterNot(_.isEmpty).map("connections" -> connections(_))
    }

  private def connections(all: java.util.Map[String, ToolConnection]): ListMap[String, Any] =
    ListMap.from(all.entrySet.asScala.map { e =>
      val c = e.getValue
      e.getKey -> (ListMap[String, Any](
        "connectionId" -> c.connectionId,
        "app" -> c.app,
        "appName" -> c.appName,
        "accessToken" -> c.accessToken,
        "account" -> ListMap("id" -> c.account.id, "label" -> c.account.label)) ++
        Option(c.expiresAt).map("expiresAt" -> _))
    })
}
