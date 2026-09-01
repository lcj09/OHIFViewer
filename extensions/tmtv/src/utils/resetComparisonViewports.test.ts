import { cache } from '@cornerstonejs/core';
import comparison, {
  VIEWPORT_IDS_BY_SIDE,
  TMTV_COMPARE_PROTOCOL_ID,
} from '../services/TMTVComparisonService';
import crosshairs from '../services/TMTVCrosshairService';
import resetComparisonViewports from './resetComparisonViewports';
import initialState from '../services/TMTVComparisonInitialState';

jest.mock('@cornerstonejs/tools', () => ({ SynchronizerManager: { createSynchronizer: jest.fn() } }));

jest.mock('@cornerstonejs/core', () => ({
  cache: { getVolume: jest.fn(), getImage: jest.fn() },
  utilities: {
    windowLevel: {
      // 与当前 Cornerstone LINEAR 窗位换算一致，不能省略 DICOM 的半像素修正。
      toLowHighRange: (width, center) => ({
        lower: center - width / 2,
        upper: center + width / 2 - 1,
      }),
    },
  },
  Enums: { Events: { VOI_MODIFIED: 'CORNERSTONE_VOI_MODIFIED' } },
}));
jest.mock('../services/TMTVCrosshairService', () => ({
  __esModule: true,
  default: { stopInteractions: jest.fn(), resetRotationAngles: jest.fn() },
}));

describe('comparison viewport reset', () => {
  let manager;
  let metadata;
  let settings;
  let viewports: Map<string, any>;
  let volumes: Map<string, any>;
  let cameraSync;
  let disabledSync;

  beforeEach(() => {
    settings = { comparisonStudySync: true, voiSync: true };
    volumes = new Map();
    for (const side of ['baseline', 'followup']) {
      for (const modality of ['CT', 'PT']) {
        volumes.set(`${side}-${modality}`, {
          metadata: { Modality: modality },
          imageIds: [`${side}-${modality}-image`],
        });
      }
    }
    (cache.getVolume as jest.Mock).mockImplementation(id => volumes.get(id));
    (cache.getImage as jest.Mock).mockReturnValue(undefined);
    metadata = {
      get: jest.fn((type, imageId) => {
        if (type === 'scalingModule')
          return imageId.includes('baseline-PT') ? { suvbw: 0.002 } : undefined;
        if (type === 'voiLutModule')
          return imageId.includes('-CT-')
            ? { windowWidth: [80], windowCenter: [35] }
            : { windowWidth: [1200], windowCenter: [600] };
      }),
    };
    cameraSync = {
      enabled: true,
      isDisabled: () => !cameraSync.enabled,
      setEnabled: jest.fn(value => {
        cameraSync.enabled = value;
      }),
    };
    disabledSync = { isDisabled: () => true, setEnabled: jest.fn() };
    viewports = new Map();
    [...VIEWPORT_IDS_BY_SIDE.baseline, ...VIEWPORT_IDS_BY_SIDE.followup].forEach(id => {
      const side = id.startsWith('baseline') ? 'baseline' : 'followup';
      const modalities = id.includes('Fusion') ? ['CT', 'PT'] : [id.includes('CT') ? 'CT' : 'PT'];
      const element = document.createElement('div');
      const viewport = {
        id,
        element,
        renderingEngineId: 'engine',
        camera: { parallelScale: 90, focalPoint: [999, 999, 999] },
        initialCamera: { parallelScale: 100, focalPoint: [0, 0, 0] },
        getCamera: () => viewport.camera,
        getActors: () => modalities.map(modality => ({ referencedId: `${side}-${modality}` })),
        resetCamera: jest.fn(options => {
          expect(cameraSync.enabled).toBe(false);
          viewport.camera = {
            parallelScale: 100,
            focalPoint: [0, 0, side === 'baseline' ? 10 : 200],
          };
          if (options.storeAsInitialCamera) {
            viewport.initialCamera = JSON.parse(JSON.stringify(viewport.camera));
          }
        }),
        getZoom: jest.fn(
          () => viewport.initialCamera.parallelScale / viewport.camera.parallelScale
        ),
        setZoom: jest.fn(),
        setCamera: jest.fn((camera, storeAsInitialCamera) => {
          viewport.camera = JSON.parse(JSON.stringify(camera));
          if (storeAsInitialCamera) {
            viewport.initialCamera = JSON.parse(JSON.stringify(viewport.camera));
          }
        }),
        invertFlag: true,
        rgbInverted: true,
        setInvert: jest.fn(value => {
          viewport.rgbInverted = !viewport.rgbInverted;
          viewport.invertFlag = value;
        }),
        resetProperties: jest.fn(),
        setProperties: jest.fn((properties, volumeId) => {
          expect(cameraSync.enabled).toBe(false);
          // 模拟底层真实顺序：invert 在 colormap 之前，重建色表会覆盖先前的反色效果。
          if (properties.invert !== undefined && properties.invert !== viewport.invertFlag) {
            viewport.setInvert(properties.invert);
          }
          if (properties.colormap) viewport.rgbInverted = false;
          element.dispatchEvent(
            new CustomEvent('CORNERSTONE_VOI_MODIFIED', {
              detail: { range: properties.voiRange, volumeId },
            })
          );
        }),
        render: jest.fn(),
      };
      viewports.set(id, viewport);
    });
    manager = {
      services: {
        hangingProtocolService: {
          getActiveProtocol: () => ({ protocol: { id: TMTV_COMPARE_PROTOCOL_ID } }),
        },
        viewportGridService: { getState: () => ({ activeViewportId: 'baselineCTAxial' }) },
        customizationService: {
          getCustomization: () => settings,
          setCustomizations: value => {
            settings = value.syncSettings;
          },
        },
        cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
        syncGroupService: {
          getSynchronizersForViewport: () => [cameraSync, disabledSync],
          addViewportToSyncGroup: jest.fn(),
          removeViewportFromSyncGroup: jest.fn(),
        },
        uiNotificationService: { show: jest.fn() },
      },
    };
    comparison.init(manager);
    comparison.setComparisonStudySyncEnabled(true);
  });

  afterEach(() => {
    comparison.reset();
    jest.clearAllMocks();
  });

  it('resets each study around its own center and restores normalized zoom to 1', () => {
    expect(resetComparisonViewports(manager, metadata)).toBe(true);
    viewports.forEach(viewport => {
      expect(viewport.resetCamera).toHaveBeenCalledWith({
        resetZoom: true,
        resetPan: true,
        resetToCenter: true,
        storeAsInitialCamera: true,
      });
      expect(viewport.setZoom).not.toHaveBeenCalled();
      expect(viewport.camera.parallelScale).toBe(100);
      expect(viewport.getZoom()).toBe(1);
      expect(viewport.camera.focalPoint).toEqual([
        0,
        0,
        viewport.id.startsWith('baseline') ? 10 : 200,
      ]);
      expect(viewport.resetProperties).not.toHaveBeenCalled();
      expect(viewport.render).toHaveBeenCalledTimes(1);
    });
    expect(cameraSync.setEnabled.mock.calls).toEqual([[false], [true]]);
    expect(disabledSync.setEnabled).not.toHaveBeenCalled();
    expect(crosshairs.stopInteractions).toHaveBeenCalledTimes(1);
  });

  it('restores each PET volume using its own SUV metadata and retains MIP thickness', () => {
    resetComparisonViewports(manager, metadata);
    expect(viewports.get('baselinePTAxial').setProperties).toHaveBeenCalledWith(
      expect.objectContaining({ voiRange: { lower: 0, upper: 4 }, invert: false }),
      'baseline-PT'
    );
    expect(viewports.get('followupPTAxial').setProperties).toHaveBeenCalledWith(
      expect.objectContaining({ voiRange: { lower: 0, upper: 1199 }, invert: false }),
      'followup-PT'
    );
    expect(viewports.get('baselineMIPSagittal').setProperties).toHaveBeenCalledWith(
      expect.objectContaining({ slabThickness: 500, voiRange: { lower: 0, upper: 4 } }),
      'baseline-PT'
    );
  });

  it('restores separate CT and PET fusion layers without VOI cross-study feedback', () => {
    resetComparisonViewports(manager, metadata);
    const fusion = viewports.get('baselineFusionAxial');
    expect(fusion.setProperties).toHaveBeenCalledTimes(3);
    expect(fusion.setProperties).toHaveBeenCalledWith(
      expect.objectContaining({
        voiRange: { lower: -5, upper: 74 },
        colormap: { name: 'Grayscale' },
        invert: false,
      }),
      'baseline-CT'
    );
    expect(fusion.setProperties).toHaveBeenCalledWith(
      expect.objectContaining({
        voiRange: { lower: 0, upper: 4 },
        colormap: expect.objectContaining({ name: 'hsv' }),
        invert: false,
      }),
      'baseline-PT'
    );
    expect(viewports.get('followupPTAxial').setProperties).toHaveBeenCalledTimes(2);
    expect(fusion.setProperties).toHaveBeenLastCalledWith(
      { voiRange: { lower: -5, upper: 74 } },
      'baseline-CT'
    );
  });

  it.each([NaN, Infinity, 0, -1])(
    'fits the image and restores zoom 1 from invalid scale %s',
    scale => {
      viewports.get('baselineCTAxial').camera.parallelScale = scale;
      resetComparisonViewports(manager, metadata);
      expect(viewports.get('baselineCTAxial').resetCamera).toHaveBeenCalledWith(
        expect.objectContaining({ resetZoom: true })
      );
      expect(viewports.get('baselineCTAxial').camera.parallelScale).toBe(100);
      expect(viewports.get('baselineCTAxial').getZoom()).toBe(1);
    }
  );

  it('resets only the active examination when comparison synchronization is off', () => {
    comparison.setComparisonStudySyncEnabled(false);
    resetComparisonViewports(manager, metadata);
    VIEWPORT_IDS_BY_SIDE.followup.forEach(id =>
      expect(viewports.get(id).resetCamera).not.toHaveBeenCalled()
    );
    expect(crosshairs.resetRotationAngles).toHaveBeenCalledWith('baseline');
  });

  it('restores synchronizers even if a viewport fails and continues resetting remaining viewports', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    viewports.get('baselineCTAxial').resetCamera.mockImplementation(() => {
      throw new Error('destroyed');
    });
    resetComparisonViewports(manager, metadata);
    expect(cameraSync.enabled).toBe(true);
    expect(disabledSync.setEnabled).not.toHaveBeenCalled();
    expect(viewports.get('followupPTAxial').resetCamera).toHaveBeenCalledTimes(1);
    expect(manager.services.uiNotificationService.show).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it('does not invoke the comparison reset outside the comparison protocol', () => {
    manager.services.hangingProtocolService.getActiveProtocol = () => ({
      protocol: { id: 'default' },
    });
    expect(resetComparisonViewports(manager, metadata)).toBe(false);
    viewports.forEach(viewport => expect(viewport.resetCamera).not.toHaveBeenCalled());
  });

  it('allows subsequent cross-study windowing after reset completes', () => {
    resetComparisonViewports(manager, metadata);
    viewports.forEach(viewport => {
      viewport.setProperties = jest.fn();
    });
    viewports.get('baselineCTAxial').element.dispatchEvent(
      new CustomEvent('CORNERSTONE_VOI_MODIFIED', {
        detail: { volumeId: 'baseline-CT', range: { lower: -20, upper: 180 } },
      })
    );
    expect(viewports.get('followupCTAxial').setProperties).toHaveBeenCalledWith(
      { voiRange: { lower: -20, upper: 180 } },
      'followup-CT',
      false
    );
  });

  it('skips unloaded viewports and missing volume metadata without new image loading', () => {
    viewports.delete('baselineCTAxial');
    volumes.delete('baseline-PT');
    expect(() => resetComparisonViewports(manager, metadata)).not.toThrow();
    expect(viewports.get('baselinePTAxial').setProperties).not.toHaveBeenCalled();
    expect(cameraSync.enabled).toBe(true);
  });

  it('keeps PET and MIP inverted after repeated resets regardless of previous inversion flags', () => {
    for (const flag of [true, false, true]) {
      viewports.forEach(viewport => {
        viewport.invertFlag = flag;
      });
      resetComparisonViewports(manager, metadata);
      for (const side of ['baseline', 'followup']) {
        for (const suffix of ['PTAxial', 'MIPSagittal']) {
          const viewport = viewports.get(`${side}${suffix}`);
          expect(viewport.invertFlag).toBe(true);
          expect(viewport.rgbInverted).toBe(true);
        }
      }
    }
  });

  it('captures initial cameras and ranges before interaction and restores exact PET and MIP positions', () => {
    const originals = new Map();
    viewports.forEach(viewport => {
      viewport.camera = {
        parallelScale: 90,
        focalPoint: [10, 20, 30],
        position: [10, 20, 130],
        viewUp: [0, -1, 0],
        viewPlaneNormal: [0, 0, 1],
      };
      viewport.getProperties = volumeId => ({
        voiRange: volumeId.endsWith('PT') ? { lower: 0, upper: 4 } : { lower: -5, upper: 74 },
      });
      originals.set(viewport.id, JSON.parse(JSON.stringify(viewport.camera)));
    });
    document.dispatchEvent(new Event('keydown'));
    viewports.forEach(viewport => {
      viewport.camera.focalPoint[2] = 999;
      viewport.camera.parallelScale = 500;
      viewport.getProperties = () => ({ voiRange: { lower: -100, upper: 300 } });
    });
    document.dispatchEvent(new Event('wheel'));
    resetComparisonViewports(manager, metadata);
    viewports.forEach(viewport => {
      expect(viewport.camera).toEqual(originals.get(viewport.id));
      expect(viewport.initialCamera).toEqual(originals.get(viewport.id));
      expect(viewport.getZoom()).toBe(1);
    });
    expect(viewports.get('followupPTAxial').setProperties).toHaveBeenLastCalledWith(
      { voiRange: { lower: 0, upper: 4 } },
      'followup-PT'
    );
    comparison.reset();
    document.dispatchEvent(new Event('keydown'));
    expect(initialState.get(viewports.get('baselineCTAxial'))).toBeUndefined();
  });

  it('invalidates initial state when a reused viewport loads a different volume', () => {
    const viewport = viewports.get('baselineCTAxial');
    viewport.camera = {
      parallelScale: 90,
      focalPoint: [10, 20, 30],
      position: [10, 20, 130],
      viewUp: [0, -1, 0],
      viewPlaneNormal: [0, 0, 1],
    };
    viewport.getProperties = () => ({ voiRange: { lower: -5, upper: 74 } });
    document.dispatchEvent(new Event('keydown'));
    expect(initialState.get(viewport)).toBeDefined();
    viewport.getActors = () => [{ referencedId: 'followup-CT' }];
    expect(initialState.get(viewport)).toBeUndefined();
  });
});
