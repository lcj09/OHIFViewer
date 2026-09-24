import { cache, Enums as csEnums } from '@cornerstonejs/core';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';

import installTMTVSegmentationRenderGuard from './installTMTVSegmentationRenderGuard';

describe('TMTV segmentation render guard', () => {
  const segmentationId = 'tmtv-segmentation';
  const volumeId = 'tmtv-labelmap-volume';
  const edgeBlendMode = csEnums.BlendModes.LABELMAP_EDGE_PROJECTION_BLEND;
  const makeServicesManager = labelmapData => {
    const addSegmentationRepresentation = jest.fn(() => Promise.resolve());
    const segmentationService = {
      addSegmentationRepresentation,
      getSegmentation: () => ({
        representationData: {
          [csToolsEnums.SegmentationRepresentations.Labelmap]: labelmapData,
        },
      }),
    };

    return {
      servicesManager: { services: { segmentationService } },
      segmentationService,
      addSegmentationRepresentation,
    };
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps edge projection when the labelmap volume is cached', async () => {
    jest.spyOn(cache, 'getVolume').mockReturnValue({ dimensions: [10, 10, 10] } as any);
    const { servicesManager, segmentationService, addSegmentationRepresentation } =
      makeServicesManager({ volumeId });
    const guard = installTMTVSegmentationRenderGuard(servicesManager);

    await segmentationService.addSegmentationRepresentation('ptAXIAL', {
      segmentationId,
      type: csToolsEnums.SegmentationRepresentations.Labelmap,
      config: { blendMode: edgeBlendMode },
    });

    expect(addSegmentationRepresentation).toHaveBeenCalledWith(
      'ptAXIAL',
      expect.objectContaining({ config: { blendMode: edgeBlendMode } })
    );
    guard.dispose();
  });

  it('falls back to regular projection while image-backed labelmap volume is rebuilding', async () => {
    jest.spyOn(cache, 'getVolume').mockReturnValue(undefined);
    const { servicesManager, segmentationService, addSegmentationRepresentation } =
      makeServicesManager({ volumeId, imageIds: ['image-1'] });
    const guard = installTMTVSegmentationRenderGuard(servicesManager);

    await segmentationService.addSegmentationRepresentation('mipSagittal', {
      segmentationId,
      type: csToolsEnums.SegmentationRepresentations.Labelmap,
      config: { blendMode: edgeBlendMode },
    });

    expect(addSegmentationRepresentation).toHaveBeenCalledWith(
      'mipSagittal',
      expect.objectContaining({
        config: { blendMode: csEnums.BlendModes.MAXIMUM_INTENSITY_BLEND },
      })
    );
    guard.dispose();
  });

  it('skips stale volume-only labelmaps and restores the original method on dispose', async () => {
    jest.spyOn(cache, 'getVolume').mockReturnValue(undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { servicesManager, segmentationService, addSegmentationRepresentation } =
      makeServicesManager({ volumeId });
    const originalMethod = segmentationService.addSegmentationRepresentation;
    const guard = installTMTVSegmentationRenderGuard(servicesManager);

    await segmentationService.addSegmentationRepresentation('mipSagittal', {
      segmentationId,
      config: { blendMode: edgeBlendMode },
    });

    expect(addSegmentationRepresentation).not.toHaveBeenCalled();
    guard.dispose();
    expect(segmentationService.addSegmentationRepresentation).toBe(originalMethod);
  });
});
