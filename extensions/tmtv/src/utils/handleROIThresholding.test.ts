import { handleROIThresholding } from './handleROIThresholding';

describe('handleROIThresholding', () => {
  it('does not start metabolic statistics for an empty or incomplete segmentation', async () => {
    const commandsManager = { run: jest.fn() };
    const segmentationService = {
      getSegmentations: jest.fn(() => []),
      addOrUpdateSegmentation: jest.fn(),
    };

    await expect(
      handleROIThresholding({
        commandsManager,
        segmentationService,
        segmentationId: 'pending',
        segmentations: [undefined, { segmentationId: 'pending' }],
      })
    ).resolves.toBeNull();

    expect(commandsManager.run).not.toHaveBeenCalled();
    expect(segmentationService.addOrUpdateSegmentation).not.toHaveBeenCalled();
  });

  it('calculates and stores statistics for a registered labelmap', async () => {
    const segmentation = {
      segmentationId: 'baseline-segmentation',
      representationData: { Labelmap: { volumeId: 'segmentation-volume' } },
      cachedStats: {},
    };
    const commandsManager = { run: jest.fn().mockResolvedValue({ tmtv: 12.5 }) };
    const segmentationService = {
      getSegmentations: jest.fn(),
      addOrUpdateSegmentation: jest.fn(),
    };

    await handleROIThresholding({
      commandsManager,
      segmentationService,
      segmentationId: segmentation.segmentationId,
      segmentations: [segmentation],
    });

    expect(commandsManager.run).toHaveBeenCalledWith('calculateTMTV', {
      segmentations: [segmentation],
    });
    expect(segmentationService.addOrUpdateSegmentation).toHaveBeenCalledWith(segmentation);
  });
});
