// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.kindgi.client.models.EvalRun;
import com.kindgi.client.models.JudgedComparisonResult;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * {@link Comparisons#comparisonOf} reads a comparison eval run's result as the OpenAPI {@code
 * JudgedComparisonResult}. The run and result below are the same fixture the TypeScript and Python
 * clients' tests use, so the three read it alike.
 */
class ComparisonsTest {
  /** A comparison eval run, as the runtime returns it, with its result. */
  private static final String JUDGED =
      """
      {
        "runId": "00000000-0000-4000-8000-00000000e001",
        "tenantId": "00000000-0000-4000-8000-000000000002",
        "suiteId": "acme.set",
        "suiteVersion": "1.0.0",
        "kind": "judged",
        "flowRef": { "flowId": "acme.intake", "version": "1.1.0" },
        "status": "completed",
        "dryRun": false,
        "startedAt": "2026-10-06T08:00:00Z",
        "result": {
          "summary": {
            "evalRunId": "er-1",
            "status": "completed",
            "completedAt": "2026-10-06T08:00:00.000Z",
            "suite": { "id": "acme.set", "version": "1.0.0" },
            "candidate": {
              "kind": "flow",
              "flowId": "acme.intake",
              "version": "1.1.0",
              "versions": { "agents": { "acme.drafter": "0.2.0" } }
            },
            "baseline": {
              "kind": "recorded",
              "versions": [{ "flowId": "acme.intake", "version": "1.0.0", "cases": 2 }]
            },
            "scope": { "projectId": "p-1" },
            "cases": 2,
            "diverged": 0,
            "refusedWrites": 1,
            "errors": 0,
            "stopped": 1,
            "reads": "recorded",
            "sampling": { "models": [{ "providerId": "acme", "model": "m-1", "runs": 1 }] },
            "repetitions": 1,
            "metrics": {
              "weightedYesShare": {
                "baseline": 0.5, "candidate": 0.75, "delta": 0.25,
                "n": 2, "weight": 2, "baselineN": 2, "baselineWeight": 2, "direction": "higher"
              },
              "judgedCoverage": {
                "baseline": 1, "candidate": 1, "delta": 0,
                "n": 2, "weight": 2, "baselineN": 2, "baselineWeight": 2, "direction": "higher"
              },
              "weightedPrecisionAtK": {
                "baseline": 0.5, "candidate": 0.75, "delta": 0.25,
                "n": 2, "weight": 2, "baselineN": 2, "baselineWeight": 2, "direction": "higher", "k": 10
              }
            }
          },
          "perCase": [
            {
              "caseId": "run-1",
              "runIds": ["replay-1"],
              "baseline": {
                "yesWeight": 1, "totalWeight": 2, "items": 2, "judgedItems": 2,
                "topK": { "yesWeight": 1, "totalWeight": 2 }
              },
              "candidate": [{
                "yesWeight": 1.5, "totalWeight": 2, "items": 2, "judgedItems": 2,
                "topK": { "yesWeight": 1.5, "totalWeight": 2 }
              }],
              "changes": {
                "kept": [{ "key": "m1", "rankBefore": 0, "rank": 0 }],
                "dropped": [],
                "new": [{ "key": "m3", "pointer": "/matches/1", "rank": 1 }]
              },
              "tools": [{
                "step": 0, "callId": "look", "toolId": "acme.lookup",
                "toolVersion": "1.0.0", "arguments": { "q": "x" }, "source": "recorded"
              }],
              "diverged": false,
              "refusedWrites": 0,
              "noContext": false,
              "approvalSkipped": false
            },
            {
              "caseId": "run-2",
              "runIds": ["replay-2"],
              "baseline": {
                "yesWeight": 0, "totalWeight": 1, "items": 1, "judgedItems": 1,
                "topK": { "yesWeight": 0, "totalWeight": 1 }
              },
              "candidate": [],
              "changes": { "kept": [], "dropped": [], "new": [] },
              "diverged": false,
              "refusedWrites": 1,
              "noContext": false,
              "approvalSkipped": false,
              "stopped": { "toolId": "acme.send", "arguments": { "to": "desk" }, "reason": "no recorded result" }
            }
          ]
        }
      }
      """;

  /** The run with its map edited, round-tripped back to an {@link EvalRun}. */
  private static EvalRun runWith(Consumer<Map<String, Object>> edit) {
    @SuppressWarnings("unchecked")
    Map<String, Object> map = KindgiJson.read(JUDGED, Map.class);
    edit.accept(map);
    return KindgiJson.read(KindgiJson.write(map), EvalRun.class);
  }

  @Test
  void readsAComparisonsResultTyped() {
    EvalRun judged = KindgiJson.read(JUDGED, EvalRun.class);

    Optional<JudgedComparisonResult> result = Comparisons.comparisonOf(judged);

    assertThat(result).isPresent();
    JudgedComparisonResult comparison = result.orElseThrow();
    assertThat(comparison.summary().metrics().weightedYesShare().delta()).isEqualTo(0.25);
    assertThat(comparison.summary().stopped()).isEqualTo(1L);
    assertThat(comparison.perCase()).hasSize(2);
    assertThat(comparison.perCase().get(1).stopped()).isNotNull();
    assertThat(comparison.perCase().get(1).stopped().toolId()).isEqualTo("acme.send");
  }

  @Test
  void emptyForEachReasonOnItsOwn() {
    // Each run below trips exactly one of the four conditions in comparisonOf, so dropping any
    // single guard would make this test fail — a non-judged kind, no result yet, a result with no
    // summary, and a result with no perCase list.

    // Another kind of run, but with the judged result kept — only the kind guard makes it empty.
    EvalRun otherKind = runWith(run -> run.put("kind", "accuracy"));
    assertThat(Comparisons.comparisonOf(otherKind)).isEmpty();

    // A judged run that hasn't finished — no result yet — only the result-present guard.
    EvalRun unfinished =
        runWith(
            run -> {
              run.put("status", "running");
              run.remove("result");
            });
    assertThat(Comparisons.comparisonOf(unfinished)).isEmpty();

    // A judged run whose result has the perCase list but no summary — only the summary guard.
    // Without that guard this would throw (summary is required), not return empty.
    EvalRun noSummary =
        runWith(
            run -> {
              @SuppressWarnings("unchecked")
              Map<String, Object> result = (Map<String, Object>) run.get("result");
              result.remove("summary");
            });
    assertThat(Comparisons.comparisonOf(noSummary)).isEmpty();

    // A judged run whose result has a summary but no perCase list — only the perCase guard.
    EvalRun noPerCase =
        runWith(
            run -> {
              @SuppressWarnings("unchecked")
              Map<String, Object> result = (Map<String, Object>) run.get("result");
              result.remove("perCase");
            });
    assertThat(Comparisons.comparisonOf(noPerCase)).isEmpty();
  }

  @Test
  void aResultThatDoesNotFitIsAnError() {
    EvalRun broken =
        runWith(
            run -> {
              @SuppressWarnings("unchecked")
              Map<String, Object> result = (Map<String, Object>) run.get("result");
              @SuppressWarnings("unchecked")
              Map<String, Object> summary = (Map<String, Object>) result.get("summary");
              summary.put("cases", "two");
            });
    assertThatThrownBy(() -> Comparisons.comparisonOf(broken)).isInstanceOf(KindgiJsonException.class);
  }
}
