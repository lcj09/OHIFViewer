import addSegmentationRepresentationPreservingCamera from './addSegmentationRepresentationPreservingCamera';
import { eventTarget, triggerEvent } from '@cornerstonejs/core';
import { Enums as csToolsEnums } from '@cornerstonejs/tools';

const triggerRendered = (viewportId: string, segmentationId: string) => {
  triggerEvent(eventTarget, csToolsEnums.Events.SEGMENTATION_RENDERED, {
    viewportId,
    segmentationId,
  });
};

describe('addSegmentationRepresentationPreservingCamera', () => {
  it('restores camera state while synchronizers are paused', async () => {
    let camera = {
      parallelScale: 80,
      focalPoint: [1, 2, 3],
      position: [4, 5, 6],
      viewPlaneNormal: [0, 0, 1],
      viewUp: [0, 1, 0],
    };
    const synchronizer = { isDisabled: () => false, setEnabled: jest.fn() };
    const viewport = {
      initialCamera: { ...camera },
      getCamera: jest.fn(() => camera),
      setCamera: jest.fn(nextCamera => {
        camera = nextCamera;
      }),
      setInitialCamera: jest.fn(function (nextCamera) {
        this.initialCamera = nextCamera;
      }),
      render: jest.fn(),
    };
    const segmentationService = {
      addSegmentationRepresentation: jest.fn(async () => {
        camera = { ...camera, parallelScale: 240 };
        triggerRendered('baselinePTAxial', 'baseline-segmentation');
      }),
    };
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
        segmentationService,
        syncGroupService: { getSynchronizersForViewport: () => [synchronizer] },
      },
    };

    await addSegmentationRepresentationPreservingCamera(
      servicesManager,
      'baselinePTAxial',
      'baseline-segmentation'
    );

    expect(camera.parallelScale).toBe(80);
    expect(synchronizer.setEnabled.mock.calls).toEqual([[false], [true]]);
    expect(viewport.render).toHaveBeenCalledTimes(1);
  });

  it('does not write a captured camera into a replacement viewport', async () => {
    const originalViewport = {
      getCamera: () => ({ parallelScale: 80 }),
      setCamera: jest.fn(),
    };
    const replacementViewport = { setCamera: jest.fn() };
    let currentViewport = originalViewport;
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: () => currentViewport },
        segmentationService: {
          addSegmentationRepresentation: jest.fn(async () => {
            currentViewport = replacementViewport;
            triggerRendered('baselinePTAxial', 'baseline-segmentation');
          }),
        },
      },
    };

    await addSegmentationRepresentationPreservingCamera(
      servicesManager,
      'baselinePTAxial',
      'baseline-segmentation'
    );

    expect(originalViewport.setCamera).not.toHaveBeenCalled();
    expect(replacementViewport.setCamera).not.toHaveBeenCalled();
  });

  it('restores the camera and synchronizer when representation creation fails', async () => {
    const synchronizer = { isDisabled: () => false, setEnabled: jest.fn() };
    const viewport = {
      getCamera: () => ({ parallelScale: 80 }),
      setCamera: jest.fn(),
      render: jest.fn(),
    };
    const servicesManager = {
      services: {
        cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
        segmentationService: {
          addSegmentationRepresentation: jest.fn().mockRejectedValue(new Error('add failed')),
        },
        syncGroupService: { getSynchronizersForViewport: () => [synchronizer] },
      },
    };

    await expect(
      addSegmentationRepresentationPreservingCamera(
        servicesManager,
        'baselinePTAxial',
        'baseline-segmentation'
      )
    ).rejects.toThrow('add failed');

    expect(viewport.setCamera).toHaveBeenCalledWith(expect.objectContaining({ parallelScale: 80 }));
    expect(synchronizer.setEnabled.mock.calls).toEqual([[false], [true]]);
  });
});
