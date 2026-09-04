import { cache, Enums } from '@cornerstonejs/core';
import comparison, {
  TMTV_COMPARE_PROTOCOL_ID,
  VIEWPORT_IDS_BY_SIDE,
} from './TMTVComparisonService';
import { TMTVCrosshairService } from './TMTVCrosshairService';

jest.mock('@cornerstonejs/tools', () => ({
  SynchronizerManager: { createSynchronizer: jest.fn() },
}));

jest.mock('@cornerstonejs/core', () => ({
  cache: { getVolume: jest.fn() },
  Enums: { Events: { VOI_MODIFIED: 'CORNERSTONE_VOI_MODIFIED' } },
}));

describe('TMTV comparison interactions', () => {
  let servicesManager;
  let viewports: Map<string, any>;
  let settings;
  let protocolId: string;
  let volumesChanged: () => void;
  let unsubscribe;
  let crosshairs: TMTVCrosshairService;
  let observers: {
    observe: jest.Mock;
    disconnect: jest.Mock;
    callback: (entries: any[]) => void;
  }[];
  const originalResizeObserver = global.ResizeObserver;

  // 2026-08-31 功能说明：模拟独立检查 Volume 和真实 DOM 事件，验证同步而不加载医学图像。
  function makeViewport(id: string, center = [100, 100, 10]) {
    const side = id.startsWith('baseline') ? 'baseline' : 'followup';
    const modalities = id.includes('Fusion') ? ['CT', 'PT'] : [id.includes('CT') ? 'CT' : 'PT'];
    const actors = modalities.map(modality => ({ referencedId: `${side}-${modality}` }));
    const element = document.createElement('div');
    const canvas = document.createElement('canvas');
    Object.defineProperties(canvas, { clientWidth: { value: 400 }, clientHeight: { value: 400 } });
    element.appendChild(canvas);
    const viewport = {
      id,
      element,
      canvas,
      renderingEngineId: 'test-engine',
      getActors: () => actors,
      getFrameOfReferenceUID: () => side,
      getCamera: () => ({
        focalPoint: [...center],
        viewPlaneNormal: [0, 0, 1],
        viewUp: [0, -1, 0],
      }),
      worldToCanvas: jest.fn(point => [point[0], point[1]]),
      canvasToWorld: point => [point[0], point[1], center[2]],
      setProperties: jest.fn((properties, volumeId, suppressEvents) => {
        if (!suppressEvents) emitVoi(viewport, volumeId, properties.voiRange);
      }),
      render: jest.fn(),
    };
    return viewport;
  }

  // 2026-08-31 功能说明：发送与 Cornerstone 调窗相同的事件载荷。
  function emitVoi(viewport, volumeId, range = { lower: -100, upper: 200 }) {
    viewport.element.dispatchEvent(
      new CustomEvent(Enums.Events.VOI_MODIFIED, {
        detail: { volumeId, range },
      })
    );
  }

  beforeEach(() => {
    settings = { voiSync: true, comparisonStudySync: false };
    protocolId = TMTV_COMPARE_PROTOCOL_ID;
    viewports = new Map();
    [...VIEWPORT_IDS_BY_SIDE.baseline, ...VIEWPORT_IDS_BY_SIDE.followup].forEach(id => {
      viewports.set(id, makeViewport(id));
    });
    (cache.getVolume as jest.Mock).mockImplementation(id => {
      const modality = id?.split('-')[1];
      return modality === 'CT' || modality === 'PT'
        ? { metadata: { Modality: modality } }
        : undefined;
    });
    unsubscribe = jest.fn();
    servicesManager = {
      services: {
        hangingProtocolService: { getActiveProtocol: () => ({ protocol: { id: protocolId } }) },
        customizationService: {
          getCustomization: () => settings,
          setCustomizations: value => {
            settings = value.syncSettings;
          },
        },
        cornerstoneViewportService: {
          getCornerstoneViewport: id => viewports.get(id),
          EVENTS: { VIEWPORT_VOLUMES_CHANGED: 'volumesChanged' },
          subscribe: (_event, callback) => {
            volumesChanged = callback;
            return { unsubscribe };
          },
        },
        syncGroupService: {
          addViewportToSyncGroup: jest.fn(),
          removeViewportFromSyncGroup: jest.fn(),
        },
      },
    };
    comparison.init(servicesManager);
    observers = [];
    global.ResizeObserver = jest.fn().mockImplementation(callback => {
      const observer = { observe: jest.fn(), disconnect: jest.fn(), callback };
      observers.push(observer);
      return observer;
    });
    crosshairs = new TMTVCrosshairService();
    crosshairs.setServicesManager(servicesManager);
    crosshairs.setStageId('tmtv-comparison-2x4');
  });

  afterEach(() => {
    crosshairs.reset();
    comparison.reset();
    global.ResizeObserver = originalResizeObserver;
    jest.clearAllMocks();
  });

  it('detects the comparison protocol through the actual hanging protocol API', () => {
    expect(comparison.isComparisonProtocolActive()).toBe(true);
    protocolId = 'default';
    expect(comparison.isComparisonProtocolActive()).toBe(false);
  });

  it('pauses comparison camera groups for crosshair rotation without enabling previously disabled groups', () => {
    const active = { setEnabled: jest.fn(), isDisabled: () => false };
    const inactive = { setEnabled: jest.fn(), isDisabled: () => true };
    servicesManager.services.syncGroupService.getSynchronizersForViewport = () => [
      active,
      inactive,
    ];
    servicesManager.services.syncGroupService.getSynchronizerType = () => 'tmtvComparisonCamera';
    const suspended = (crosshairs as any)._disableSynchronizers();
    expect(suspended).toEqual([active]);
    (crosshairs as any)._restoreSynchronizers(suspended);
    expect(active.setEnabled.mock.calls).toEqual([[false], [true]]);
    expect(inactive.setEnabled).not.toHaveBeenCalled();
  });

  it.each(['baseline', 'followup'])(
    'synchronizes CT from %s to the other CT and fusion CT layer',
    side => {
      const other = side === 'baseline' ? 'followup' : 'baseline';
      comparison.setComparisonStudySyncEnabled(true);
      emitVoi(viewports.get(`${side}CTAxial`), `${side}-CT`);
      for (const suffix of ['CTAxial', 'FusionAxial']) {
        expect(viewports.get(`${other}${suffix}`).setProperties).toHaveBeenCalledWith(
          { voiRange: { lower: -100, upper: 200 } },
          `${other}-CT`,
          false
        );
        expect(viewports.get(`${other}${suffix}`).setProperties).toHaveBeenCalledTimes(1);
      }
      expect(viewports.get(`${other}PTAxial`).setProperties).not.toHaveBeenCalled();
      expect(viewports.get(`${side}CTAxial`).setProperties).not.toHaveBeenCalled();
    }
  );

  it('maps fusion PET VOI to the other PET, fusion and MIP without copying the colormap', () => {
    comparison.setComparisonStudySyncEnabled(true);
    emitVoi(viewports.get('baselineFusionAxial'), 'baseline-PT');
    for (const suffix of ['PTAxial', 'FusionAxial', 'MIPSagittal']) {
      expect(viewports.get(`followup${suffix}`).setProperties).toHaveBeenCalledWith(
        { voiRange: { lower: -100, upper: 200 } },
        'followup-PT',
        false
      );
    }
    expect(viewports.get('followupCTAxial').setProperties).not.toHaveBeenCalled();
  });

  it('stops VOI synchronization when either switch is off and restores it without duplicate listeners', () => {
    comparison.setComparisonStudySyncEnabled(true);
    settings.voiSync = false;
    comparison.applyComparisonStudySyncFromSettings();
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).not.toHaveBeenCalled();
    settings.voiSync = true;
    comparison.applyComparisonStudySyncFromSettings();
    comparison.applyComparisonStudySyncFromSettings();
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).toHaveBeenCalledTimes(1);
    comparison.setComparisonStudySyncEnabled(false);
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).toHaveBeenCalledTimes(1);
  });

  it('rebinds rebuilt viewports when volumes become ready and releases old element listeners', () => {
    comparison.setComparisonStudySyncEnabled(true);
    const oldViewport = viewports.get('baselineCTAxial');
    viewports.set('baselineCTAxial', makeViewport('baselineCTAxial'));
    volumesChanged();
    emitVoi(oldViewport, 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).not.toHaveBeenCalled();
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).toHaveBeenCalledTimes(1);
    comparison.reset();
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores invalid ranges, missing volumes and destroyed targets', () => {
    comparison.setComparisonStudySyncEnabled(true);
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT', { lower: NaN, upper: 10 });
    emitVoi(viewports.get('baselineCTAxial'), 'missing');
    expect(viewports.get('followupCTAxial').setProperties).not.toHaveBeenCalled();
    viewports.delete('followupCTAxial');
    expect(() => emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT')).not.toThrow();
    expect(viewports.get('followupFusionAxial').setProperties).toHaveBeenCalledTimes(1);
  });

  it('does not create cross-study synchronization for ordinary protocols', () => {
    comparison.setComparisonStudySyncEnabled(true);
    protocolId = 'default';
    comparison.applyComparisonStudySyncFromSettings();
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).not.toHaveBeenCalled();
  });

  it('registers a viewport that becomes available after synchronization was enabled', () => {
    viewports.delete('baselineCTAxial');
    comparison.setComparisonStudySyncEnabled(true);
    viewports.set('baselineCTAxial', makeViewport('baselineCTAxial'));
    volumesChanged();
    emitVoi(viewports.get('baselineCTAxial'), 'baseline-CT');
    expect(viewports.get('followupCTAxial').setProperties).toHaveBeenCalledTimes(1);
  });

  it('restores PET scale after a side panel changes viewport width and releases observers', () => {
    jest.useFakeTimers();
    const ct = viewports.get('baselineCTAxial');
    const pet = viewports.get('baselinePTAxial');
    let petScale = 240;
    ct.getCamera = () => ({ parallelScale: 100 });
    ct.initialCamera = { parallelScale: 100 };
    pet.getCamera = () => ({ parallelScale: petScale });
    pet.initialCamera = { parallelScale: 240 };
    pet.setCamera = jest.fn(({ parallelScale }) => {
      petScale = parallelScale;
    });

    volumesChanged();
    jest.advanceTimersByTime(3000);
    petScale = 240;
    pet.setCamera.mockClear();

    const petObserver = observers.find(observer =>
      observer.observe.mock.calls.some(([element]) => element === pet.element)
    );
    expect(petObserver).toBeDefined();
    petObserver.callback([{ target: pet.element, contentRect: { width: 520, height: 400 } }]);
    jest.advanceTimersByTime(200);

    expect(pet.setCamera).toHaveBeenCalledWith({ parallelScale: 100 });
    comparison.reset();
    expect(petObserver.disconnect).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('renders all eight comparison crosshairs and keeps their initial coordinates separate', () => {
    expect(crosshairs.isTmtvLayout('tmtv-comparison-2x4')).toBe(true);
    const ids = crosshairs.getViewportIdsForStage('tmtv-comparison-2x4');
    expect(ids).toHaveLength(8);
    ids.forEach(id => {
      const viewport = makeViewport(
        id,
        id.startsWith('baseline') ? [100, 100, 10] : [200, 200, 80]
      );
      viewports.set(id, viewport);
      crosshairs.addViewport(id, viewport);
    });
    crosshairs.setVisible(true);
    ids.forEach(id => {
      const viewport = viewports.get(id);
      expect(viewport.element.querySelector('svg').style.display).toBe('');
      expect(viewport.element.querySelectorAll('line')).toHaveLength(4);
      expect(viewport.worldToCanvas).toHaveBeenLastCalledWith(
        id.startsWith('baseline') ? [100, 100, 10] : [200, 200, 80]
      );
    });
  });

  it('keeps click and rotation within one examination and excludes comparison MIP rotation targets', () => {
    ['baselineCTAxial', 'baselineMIPSagittal', 'followupCTAxial'].forEach(id => {
      crosshairs.addViewport(id, viewports.get(id));
    });
    crosshairs.setVisible(true);
    const other = viewports.get('followupCTAxial');
    other.worldToCanvas.mockClear();
    viewports
      .get('baselineCTAxial')
      .element.dispatchEvent(
        new MouseEvent('mousedown', { button: 0, clientX: 220, clientY: 250 })
      );
    expect(viewports.get('baselineCTAxial').worldToCanvas).toHaveBeenLastCalledWith([220, 250, 10]);
    expect(other.worldToCanvas).not.toHaveBeenCalled();
    comparison.syncFromViewport('followupCTAxial');
    crosshairs.rotateCrosshair(20);
    expect(crosshairs.getRotationAngle()).toBe(20);
    comparison.syncFromViewport('baselineCTAxial');
    expect(crosshairs.getRotationAngle()).toBe(0);
    const mip = viewports.get('baselineMIPSagittal');
    mip.element.dispatchEvent(new MouseEvent('mousemove', { clientX: 220, clientY: 250 }));
    Array.from(mip.element.querySelectorAll('circle')).forEach((circle: SVGCircleElement) => {
      expect(circle.style.display).toBe('none');
    });
  });

  it('cleans comparison overlays, observers and mouse listeners across repeated layout changes', () => {
    const viewport = viewports.get('baselineCTAxial');
    for (let i = 0; i < 3; i++) {
      crosshairs.addViewport(viewport.id, viewport);
      crosshairs.setVisible(true);
      expect(viewport.element.querySelectorAll('svg')).toHaveLength(1);
      crosshairs.clear();
      expect(viewport.element.querySelectorAll('svg')).toHaveLength(0);
      viewport.worldToCanvas.mockClear();
      viewport.element.dispatchEvent(
        new MouseEvent('mousedown', { button: 0, clientX: 220, clientY: 250 })
      );
      expect(viewport.worldToCanvas).not.toHaveBeenCalled();
    }
    observers.forEach(observer => expect(observer.disconnect).toHaveBeenCalledTimes(1));
    expect(crosshairs.getViewport(viewport.id)).toBeUndefined();
  });

  it.each(['baseline', 'followup'])(
    'links crosshair clicks from %s to every viewport in the other examination without echoing',
    side => {
      viewports.forEach(viewport => crosshairs.addViewport(viewport.id, viewport));
      crosshairs.setVisible(true);
      comparison.setComparisonStudySyncEnabled(true);
      viewports.forEach(viewport => viewport.worldToCanvas.mockClear());
      viewports
        .get(`${side}CTAxial`)
        .element.dispatchEvent(
          new MouseEvent('mousedown', { button: 0, clientX: 220, clientY: 250 })
        );
      viewports.forEach(viewport => {
        // 源视口额外做一次鼠标命中测试；每个视口只重绘一次。
        expect(viewport.worldToCanvas).toHaveBeenCalledTimes(
          viewport.id === `${side}CTAxial` ? 2 : 1
        );
        expect(viewport.worldToCanvas).toHaveBeenLastCalledWith([220, 250, 10]);
      });
    }
  );

  it('checks the sync switch on every drag update, independently of VOI sync', () => {
    viewports.forEach(viewport => crosshairs.addViewport(viewport.id, viewport));
    crosshairs.setVisible(true);
    settings.voiSync = false;
    comparison.setComparisonStudySyncEnabled(true);
    const target = viewports.get('followupCTAxial');
    viewports
      .get('baselineCTAxial')
      .element.dispatchEvent(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 160 }));
    expect(target.worldToCanvas).toHaveBeenLastCalledWith([140, 160, 10]);
    comparison.setComparisonStudySyncEnabled(false);
    target.worldToCanvas.mockClear();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 180, clientY: 200 }));
    expect(target.worldToCanvas).not.toHaveBeenCalled();
    comparison.setComparisonStudySyncEnabled(true);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 190, clientY: 215 }));
    expect(target.worldToCanvas).toHaveBeenLastCalledWith([150, 175, 10]);
    document.dispatchEvent(new MouseEvent('mouseup'));
    target.worldToCanvas.mockClear();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 300 }));
    expect(target.worldToCanvas).not.toHaveBeenCalled();
  });

  it('preserves the offset between unregistered examinations in world coordinates', () => {
    const source = makeViewport('baselineCTAxial', [100, 100, 10]);
    const target = makeViewport('followupCTAxial', [200, 300, 80]);
    crosshairs.addViewport(source.id, source);
    crosshairs.addViewport(target.id, target);
    crosshairs.setVisible(true);
    comparison.setComparisonStudySyncEnabled(true);
    crosshairs.setPosition([120, 130, 25]);
    expect(target.worldToCanvas).toHaveBeenLastCalledWith([220, 330, 95]);
    comparison.syncFromViewport('followupCTAxial');
    crosshairs.setPosition([225, 320, 100]);
    expect(source.worldToCanvas).toHaveBeenLastCalledWith([125, 120, 30]);
  });

  it('uses absolute world coordinates only when examinations share a reference frame', () => {
    const source = makeViewport('baselineCTAxial', [100, 100, 10]);
    const target = makeViewport('followupCTAxial', [200, 300, 80]);
    source.getFrameOfReferenceUID = () => 'shared-frame';
    target.getFrameOfReferenceUID = () => 'shared-frame';
    crosshairs.addViewport(source.id, source);
    crosshairs.addViewport(target.id, target);
    crosshairs.setVisible(true);
    comparison.setComparisonStudySyncEnabled(true);
    crosshairs.setPosition([120, 130, 25]);
    expect(target.worldToCanvas).toHaveBeenLastCalledWith([120, 130, 25]);
  });

  it('removes drag callbacks on clear and reestablishes cross-study linkage after rebuilding', () => {
    viewports.forEach(viewport => crosshairs.addViewport(viewport.id, viewport));
    crosshairs.setVisible(true);
    comparison.setComparisonStudySyncEnabled(true);
    viewports
      .get('baselineCTAxial')
      .element.dispatchEvent(
        new MouseEvent('mousedown', { button: 0, clientX: 100, clientY: 100 })
      );
    crosshairs.clear();
    viewports.forEach(viewport => viewport.worldToCanvas.mockClear());
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 160 }));
    viewports.forEach(viewport => expect(viewport.worldToCanvas).not.toHaveBeenCalled());
    viewports.forEach(viewport => crosshairs.addViewport(viewport.id, viewport));
    crosshairs.setPosition([140, 160, 10]);
    expect(viewports.get('followupCTAxial').worldToCanvas).toHaveBeenLastCalledWith([140, 160, 10]);
  });

  it('ignores invalid positions and missing peer viewports during linked positioning', () => {
    const source = viewports.get('baselineCTAxial');
    const target = viewports.get('followupCTAxial');
    crosshairs.addViewport(source.id, source);
    crosshairs.addViewport(target.id, target);
    crosshairs.setVisible(true);
    comparison.setComparisonStudySyncEnabled(true);
    target.worldToCanvas.mockClear();
    crosshairs.setPosition([NaN, 130, 10]);
    expect(target.worldToCanvas).not.toHaveBeenCalled();
    crosshairs.removeViewport(target.id);
    expect(() => crosshairs.setPosition([120, 130, 10])).not.toThrow();
    expect(target.worldToCanvas).not.toHaveBeenCalled();
  });

  it('preserves ordinary TMTV crosshair behavior after leaving comparison', () => {
    crosshairs.addViewport('baselineCTAxial', viewports.get('baselineCTAxial'));
    crosshairs.setVisible(true);
    crosshairs.clear();
    crosshairs.setStageId('2x3-layout');
    const viewport = makeViewport('ctAXIAL');
    crosshairs.addViewport(viewport.id, viewport);
    crosshairs.setPosition([40, 50, 60]);
    expect(crosshairs.getPosition()).toEqual([40, 50, 60]);
    expect(viewport.element.querySelector('svg').style.display).toBe('');
    expect(viewport.worldToCanvas).toHaveBeenLastCalledWith([40, 50, 60]);
  });
});
