import type { TMTVSessionTotals } from '../services/TMTVSessionService';

export type TMTVMetricComparison = {
  baseline: number | null;
  followup: number | null;
  delta: number | null;
  percentChange: number | null;
};

export type TMTVPatientComparison = {
  tmtv: TMTVMetricComparison;
  tlg: TMTVMetricComparison;
};

function getValidTotal(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 2026-09-03 功能说明：计算 Follow-up 相对 Baseline 的患者级绝对差值和百分比变化。 */
function calculateMetricComparison(baselineValue: unknown, followupValue: unknown) {
  const baseline = getValidTotal(baselineValue);
  const followup = getValidTotal(followupValue);
  const hasBothTotals = baseline !== null && followup !== null;
  const delta = hasBothTotals ? followup - baseline : null;
  const percentChange = hasBothTotals && baseline > 0 ? (delta / baseline) * 100 : null;

  return {
    baseline,
    followup,
    delta,
    percentChange,
  };
}

/** 2026-09-03 功能说明：分别计算 TMTV 与 TLG；缺失或无效数据保持为 null，避免构造临床默认值。 */
export function calculateTMTVPatientComparison(
  baselineTotals?: TMTVSessionTotals | null,
  followupTotals?: TMTVSessionTotals | null
): TMTVPatientComparison {
  return {
    tmtv: calculateMetricComparison(baselineTotals?.tmtv, followupTotals?.tmtv),
    tlg: calculateMetricComparison(baselineTotals?.tlg, followupTotals?.tlg),
  };
}
