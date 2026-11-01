// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.pack;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.kindgi.pack.http.HttpMethod;
import com.kindgi.pack.http.HttpToolSpec;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/**
 * A tool's approval: how an approval of a call to it reads. Each {@code {field}} is checked against
 * the input when the tool is built, with the rules {@code defineTool} applies.
 */
final class ToolApprovalTest {

  enum Channel {
    MAIL,
    PHONE
  }

  record Refund(
      int orderId,
      double amount,
      String reason,
      boolean notifyCustomer,
      Channel channel,
      List<String> lines,
      @Nullable String note) {}

  record Done(boolean ok) {}

  private static Tool<Refund, Done> refund(ToolApproval approval) {
    return Tool.define("acme.refund")
        .description("Refunds an order.")
        .input(Refund.class)
        .output(Done.class)
        .mutating(true)
        .approval(approval)
        .handler((input, ctx) -> new Done(true));
  }

  private static String refused(ToolApproval approval) {
    return assertThrows(IllegalArgumentException.class, () -> refund(approval)).getMessage();
  }

  @Test
  void placeholdersNamingRequiredScalarFieldsAreKept() {
    ToolApproval approval =
        ToolApproval.titled("Refund {amount} on order #{orderId}")
            .withSummary("{reason} (notify: {notifyCustomer}, by {channel})")
            .withAbout("acme.order", "{orderId}");
    assertEquals(approval, refund(approval).approval());
    assertEquals(
        Map.of(
            "title", "Refund {amount} on order #{orderId}",
            "summary", "{reason} (notify: {notifyCustomer}, by {channel})",
            "about", Map.of("kind", "acme.order", "id", "{orderId}")),
        approval.toIndexMap());
  }

  @Test
  void aToolWithoutOneHasNone() {
    Tool<Refund, Done> tool =
        Tool.define("acme.refund")
            .description("Refunds an order.")
            .input(Refund.class)
            .output(Done.class)
            .handler((input, ctx) -> new Done(true));
    assertNull(tool.approval());
  }

  @Test
  void anApprovalACallCouldNotFillIsRefusedWhenTheToolIsBuilt() {
    assertEquals(
        "Tool \"acme.refund\": approval.title names {total}, which isn't a field of the input",
        refused(ToolApproval.titled("Refund {total}")));
    assertEquals(
        "Tool \"acme.refund\": approval.summary names {note}, an optional field of the input: a"
            + " call may leave it out",
        refused(ToolApproval.titled("Refund {amount}").withSummary("{note}")));
    assertEquals(
        "Tool \"acme.refund\": approval.title names {lines}, a field of the input that isn't a"
            + " string, a number, an integer or a boolean",
        refused(ToolApproval.titled("Refund {lines}")));
    assertEquals(
        "Tool \"acme.refund\": approval.title has a brace that isn't part of a {field} placeholder",
        refused(ToolApproval.titled("Refund {{amount}}")));
    assertEquals(
        "Tool \"acme.refund\": approval.about.id must hold at least one {field} placeholder",
        refused(ToolApproval.titled("Refund {amount}").withAbout("acme.order", "latest")));
  }

  @Test
  void anApprovalItsSchemaRefusesIsRefusedToo() {
    for (ToolApproval approval :
        List.of(
            ToolApproval.titled(""),
            ToolApproval.titled("Refund {amount}\non order #{orderId}"),
            ToolApproval.titled("Refund").withAbout("Order", "{orderId}"))) {
      assertThat(refused(approval)).startsWith("Tool \"acme.refund\": not a valid approval: ");
    }
  }

  @Test
  void anHttpToolsApprovalIsCheckedTheSameWay() {
    HttpToolSpec spec =
        HttpToolSpec.builder()
            .method(HttpMethod.GET)
            .urlTemplate("https://api.example.com/orders/{orderId}")
            .build();
    Tool.Builder<Refund, Done> charge =
        Tool.define("acme.charge").description("Charges.").input(Refund.class).output(Done.class);
    ToolApproval kept = ToolApproval.titled("Charge order #{orderId}");
    assertEquals(kept, charge.approval(kept).http(spec).approval());
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () -> charge.approval(ToolApproval.titled("Charge {total}")).http(spec));
    assertThat(e.getMessage()).contains("approval.title names {total}");
  }
}
