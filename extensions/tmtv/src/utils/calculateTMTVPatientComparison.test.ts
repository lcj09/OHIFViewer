import { calculateTMTVPatientComparison } from './calculateTMTVPatientComparison';

describe('calculateTMTVPatientComparison', () => {
  it('calculates absolute and percentage changes from baseline to follow-up', () => {
    const result = calculateTMTVPatientComparison({ tmtv: 20, tlg: 50 }, { tmtv: 15, tlg: 75 });

    expect(result.tmtv).toEqual({
      baseline: 20,
      followup: 15,
      delta: -5,
      percentChange: -25,
    });
    expect(result.tlg).toEqual({
      baseline: 50,
      followup: 75,
      delta: 25,
      percentChange: 50,
    });
  });

  it('returns N/A-compatible null percentages when baseline is zero', () => {
    const result = calculateTMTVPatientComparison({ tmtv: 0, tlg: 0 }, { tmtv: 12, tlg: 30 });

    expect(result.tmtv).toEqual({
      baseline: 0,
      followup: 12,
      delta: 12,
      percentChange: null,
    });
    expect(result.tlg.percentChange).toBeNull();
  });

  it('keeps missing or invalid totals out of comparison calculations', () => {
    const result = calculateTMTVPatientComparison(
      { tmtv: Number.NaN, tlg: null },
      { tmtv: 8, tlg: Number.POSITIVE_INFINITY }
    );

    expect(result.tmtv).toEqual({
      baseline: null,
      followup: 8,
      delta: null,
      percentChange: null,
    });
    expect(result.tlg).toEqual({
      baseline: null,
      followup: null,
      delta: null,
      percentChange: null,
    });
  });

  it('reports a complete reduction as minus one hundred percent', () => {
    const result = calculateTMTVPatientComparison({ tmtv: 10, tlg: 25 }, { tmtv: 0, tlg: 0 });

    expect(result.tmtv.percentChange).toBe(-100);
    expect(result.tlg.percentChange).toBe(-100);
  });
});
