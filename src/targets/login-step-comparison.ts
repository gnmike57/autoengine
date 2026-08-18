export type LoginStepLayer = "discovery" | "entry" | "submit" | "acceptance";

export interface LoginStepObservation {
  layer: LoginStepLayer;
  variant: string;
  runId: string;
  success: boolean;
  latencyMs: number;
  acceptedSubmit?: boolean;
  evidenceSignalCount?: number;
  driftFixturePassed?: boolean;
  falsePass?: boolean;
}

export interface LoginStepVariantSummary {
  layer: LoginStepLayer;
  variant: string;
  runs: number;
  successCount: number;
  successRate: number;
  acceptedSubmitRate: number | null;
  evidenceCompleteRate: number | null;
  driftPassRate: number | null;
  falsePassCount: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

export function summarizeLoginStepComparisons(
  observations: readonly LoginStepObservation[],
): LoginStepVariantSummary[] {
  const groups = new Map<string, LoginStepObservation[]>();
  for (const observation of observations) {
    if (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0) {
      throw new RangeError(`Invalid latency for ${observation.layer}:${observation.variant}`);
    }
    const key = `${observation.layer}\u0000${observation.variant}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(observation);
    groups.set(key, bucket);
  }

  return [...groups.values()]
    .map((group): LoginStepVariantSummary => {
      const first = group[0]!;
      const submitObservations = group.filter((item) => item.acceptedSubmit !== undefined);
      const evidenceObservations = group.filter((item) => item.evidenceSignalCount !== undefined);
      const driftObservations = group.filter((item) => item.driftFixturePassed !== undefined);
      return {
        layer: first.layer,
        variant: first.variant,
        runs: group.length,
        successCount: group.filter((item) => item.success).length,
        successRate: ratio(group.filter((item) => item.success).length, group.length),
        acceptedSubmitRate: submitObservations.length === 0
          ? null
          : ratio(submitObservations.filter((item) => item.acceptedSubmit === true).length, submitObservations.length),
        evidenceCompleteRate: evidenceObservations.length === 0
          ? null
          : ratio(evidenceObservations.filter((item) => (item.evidenceSignalCount ?? 0) >= 2).length, evidenceObservations.length),
        driftPassRate: driftObservations.length === 0
          ? null
          : ratio(driftObservations.filter((item) => item.driftFixturePassed === true).length, driftObservations.length),
        falsePassCount: group.filter((item) => item.falsePass === true).length,
        medianLatencyMs: percentile(group.map((item) => item.latencyMs), 0.5),
        p95LatencyMs: percentile(group.map((item) => item.latencyMs), 0.95),
      };
    })
    .sort((a, b) =>
      a.layer.localeCompare(b.layer)
      || a.falsePassCount - b.falsePassCount
      || b.successRate - a.successRate
      || a.p95LatencyMs - b.p95LatencyMs
      || a.variant.localeCompare(b.variant),
    );
}
