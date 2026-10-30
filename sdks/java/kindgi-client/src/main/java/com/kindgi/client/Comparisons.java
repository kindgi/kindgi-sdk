// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

package com.kindgi.client;

import com.kindgi.client.models.EvalKind;
import com.kindgi.client.models.EvalRun;
import com.kindgi.client.models.CorrectedComparisonResult;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * A comparison eval run's result, typed.
 *
 * <p>The same reading as {@code comparisonOf} in the TypeScript client and {@code comparison_of} in
 * Python: an {@link EvalRun} of kind {@code judged} carries its comparison in the open {@code
 * result}, and this reads it as the OpenAPI {@link CorrectedComparisonResult} — its summary and each
 * case.
 */
public final class Comparisons {
  private Comparisons() {}

  /**
   * A comparison's result, typed from the OpenAPI {@code CorrectedComparisonResult}: its summary and
   * each case ({@link CorrectedComparisonResult#perCase()}).
   *
   * @param run a {@code judged} eval run (a test set compared with a version)
   * @return the typed result, or {@link Optional#empty()} for another kind of eval run, a dry run,
   *     or one that hasn't finished (no comparison in its {@code result} yet)
   * @throws KindgiJsonException when the run is a finished comparison whose {@code result} doesn't
   *     fit {@code CorrectedComparisonResult}
   */
  public static Optional<CorrectedComparisonResult> comparisonOf(EvalRun run) {
    Objects.requireNonNull(run, "run");
    Map<String, Object> result = run.result();
    if (run.kind().value() != EvalKind.Value.JUDGED
        || result == null
        || result.get("summary") == null
        || !(result.get("perCase") instanceof List<?>)) {
      return Optional.empty();
    }
    return Optional.of(KindgiJson.read(KindgiJson.write(result), CorrectedComparisonResult.class));
  }
}
