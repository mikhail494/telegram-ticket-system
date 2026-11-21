interface Budget {
  baselineLines: number;
  maxLines: number;
}
interface Baseline {
  defaultMaxLines: number;
  moduleBudgets: Record<string, Budget>;
}
export function physicalLines(text: string): number;
export function budgetErrors(
  baseline: Baseline,
  previous: Baseline | null,
  measurements: Map<string, number>
): string[];
