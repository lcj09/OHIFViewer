import classifyPhysiologicalUptake from './classifyPhysiologicalUptake';

const bounds: [number, number, number, number, number, number] = [-200, 200, -150, 150, -800, 800];

function lesion(id, centroid, volume = 20, suvMax = 12, suvMean = 6) {
  return { id, centroid, volume, suvMax, suvMean };
}

describe('classifyPhysiologicalUptake', () => {
  it('flags a high central inferior focus as urinary bladder uptake', () => {
    const result = classifyPhysiologicalUptake(
      [lesion('bladder', [0, 0, -650], 40, 20, 10)],
      bounds
    );

    expect(result.get('bladder')?.category).toBe('urinaryBladder');
  });

  it('flags only a spatially matched bilateral renal pair', () => {
    const result = classifyPhysiologicalUptake(
      [
        lesion('left', [-80, 0, 0], 35, 9, 5),
        lesion('right', [80, 10, 20], 30, 8, 4.5),
        lesion('unpaired', [-100, 0, 350], 30, 9, 5),
      ],
      bounds
    );

    expect(result.get('left')?.category).toBe('renalPair');
    expect(result.get('right')?.category).toBe('renalPair');
    expect(result.has('unpaired')).toBe(false);
  });

  it('flags organ-sized diffuse right upper abdominal uptake as liver uptake', () => {
    const result = classifyPhysiologicalUptake(
      [
        lesion('liver', [-60, 0, 100], 1057.382, 3.762, 2.824),
        lesion('focal-liver-lesion', [-60, 0, 100], 20, 14, 7),
      ],
      bounds
    );

    expect(result.get('liver')?.category).toBe('liver');
    expect(result.has('focal-liver-lesion')).toBe(false);
  });

  it('does not flag lesions when geometry or uptake evidence is insufficient', () => {
    expect(classifyPhysiologicalUptake([lesion('unknown', [0, 0, 0])], null).size).toBe(0);
    expect(
      classifyPhysiologicalUptake([lesion('pelvic', [0, 0, -650], 2, 4, 3)], bounds).size
    ).toBe(0);
  });
});
