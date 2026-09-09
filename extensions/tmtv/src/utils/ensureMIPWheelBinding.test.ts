import { getEnabledElement } from '@cornerstonejs/core';
import VolumeRotateTool from '@cornerstonejs/tools/tools/VolumeRotateTool';
import ensureMIPWheelBinding, {
  belongsToComparisonCameraGroup,
  releaseMIPTrackballResizeBindings,
} from './ensureMIPWheelBinding';

jest.mock('@cornerstonejs/core', () => ({ getEnabledElement: jest.fn() }));
jest.mock('@cornerstonejs/tools/tools/base', () => ({
  BaseTool: class {
    configuration;
    constructor(props, defaults) {
      this.configuration = { ...defaults.configuration, ...props.configuration };
    }
  },
}));

const toolNames = {
  StackScroll: 'StackScroll',
  VolumeRotate: 'VolumeRotateMouseWheel',
  TrackballRotateTool: 'TrackballRotate',
};
const enums = { MouseBindings: { Wheel: 524288 }, ToolModes: { Active: 'Active' } };

describe('MIP wheel bindings', () => {
  it('removes only scroll wheel bindings and restores rotation without changing primary tools', () => {
    const wheelBinding = { mouseButton: enums.MouseBindings.Wheel };
    const group = {
      toolOptions: {
        StackScroll: { mode: 'Active', bindings: [wheelBinding, { mouseButton: 1 }] },
        Zoom: { mode: 'Active', bindings: [wheelBinding] },
        VolumeRotateMouseWheel: { mode: 'Passive', bindings: [] },
      },
      getToolOptions: name =>
        name === toolNames.StackScroll
          ? { mode: 'Active', bindings: [wheelBinding, { mouseButton: 1 }] }
          : { mode: 'Passive', bindings: [] },
      setToolPassive: jest.fn(),
      setToolActive: jest.fn(),
    };
    ensureMIPWheelBinding({ getToolGroup: () => group }, toolNames, enums);
    expect(group.setToolPassive).toHaveBeenCalledWith('StackScroll', {
      removeAllBindings: [wheelBinding],
    });
    expect(group.setToolPassive).toHaveBeenCalledWith('Zoom', {
      removeAllBindings: [wheelBinding],
    });
    expect(group.setToolActive).toHaveBeenCalledTimes(1);
    expect(group.setToolActive).toHaveBeenCalledWith('VolumeRotateMouseWheel', {
      bindings: [wheelBinding],
    });
  });

  it('leaves an already correct tool group unchanged across repeated viewport mounts', () => {
    const group = {
      toolOptions: {
        StackScroll: { mode: 'Passive', bindings: [] },
        VolumeRotateMouseWheel: {
          mode: 'Active',
          bindings: [{ mouseButton: enums.MouseBindings.Wheel }],
        },
      },
      getToolOptions: name =>
        name === toolNames.StackScroll
          ? { mode: 'Passive', bindings: [] }
          : { mode: 'Active', bindings: [{ mouseButton: enums.MouseBindings.Wheel }] },
      setToolPassive: jest.fn(),
      setToolActive: jest.fn(),
    };
    for (let i = 0; i < 8; i++)
      ensureMIPWheelBinding({ getToolGroup: () => group }, toolNames, enums);
    expect(group.setToolActive).not.toHaveBeenCalled();
    expect(group.setToolPassive).not.toHaveBeenCalled();
  });

  it('tolerates missing tool groups during layout disposal', () => {
    expect(() => ensureMIPWheelBinding({}, toolNames, enums)).not.toThrow();
  });

  it('removes trackball resize observers after every activation without changing interaction callbacks', () => {
    const observers = [
      { disconnect: jest.fn() },
      { disconnect: jest.fn() },
      { disconnect: jest.fn() },
    ];
    const originalOnSetToolActive = jest.fn(function () {
      this._resizeObservers.set('restoredMIPSagittal', observers[2]);
    });
    const trackball = {
      _resizeObservers: new Map([
        ['baselineMIPSagittal', observers[0]],
        ['followupMIPSagittal', observers[1]],
      ]),
      onSetToolDisabled: jest.fn(function () {
        this._resizeObservers.forEach(observer => observer.disconnect());
        this._resizeObservers.clear();
      }),
      onSetToolActive: originalOnSetToolActive,
      mouseDragCallback: jest.fn(),
    };
    const group = { _toolInstances: { TrackballRotate: trackball } };

    releaseMIPTrackballResizeBindings(group, toolNames);
    observers.slice(0, 2).forEach(observer => expect(observer.disconnect).toHaveBeenCalledTimes(1));
    trackball.onSetToolActive();
    expect(originalOnSetToolActive).toHaveBeenCalledTimes(1);
    expect(observers[2].disconnect).toHaveBeenCalledTimes(1);
    expect(trackball._resizeObservers.size).toBe(0);

    releaseMIPTrackballResizeBindings(group, toolNames);
    trackball.onSetToolActive();
    expect(originalOnSetToolActive).toHaveBeenCalledTimes(2);
    expect(observers[2].disconnect).toHaveBeenCalledTimes(2);
    expect(trackball.mouseDragCallback).toBeDefined();
  });

  it.each(['Baseline', 'Followup'])(
    'keeps MIP and the opposite examination out of axialSync%s',
    side => {
      const own = side === 'Baseline' ? 'baseline' : 'followup';
      const other = own === 'baseline' ? 'followup' : 'baseline';
      for (const suffix of ['CTAxial', 'PTAxial', 'FusionAxial']) {
        expect(belongsToComparisonCameraGroup(`axialSync${side}`, `${own}${suffix}`)).toBe(true);
        expect(belongsToComparisonCameraGroup(`axialSync${side}`, `${other}${suffix}`)).toBe(false);
      }
      expect(belongsToComparisonCameraGroup(`axialSync${side}`, `${own}MIPSagittal`)).toBe(false);
      expect(belongsToComparisonCameraGroup(`axialSync${side}`, `${other}MIPSagittal`)).toBe(false);
      expect(belongsToComparisonCameraGroup('axialSync', 'ctAXIAL')).toBe(true);
    }
  );

  it.each(['baselineMIPSagittal', 'followupMIPSagittal'])(
    'uses native wheel rotation around the local center in %s',
    id => {
      const focalPoint = id.startsWith('baseline') ? [20, 30, 40] : [120, 130, 240];
      let camera = {
        focalPoint,
        position: [focalPoint[0] + 100, focalPoint[1], focalPoint[2]],
        viewUp: [0, 0, 1],
      };
      const viewport = {
        getCamera: () => camera,
        setCamera: jest.fn(update => {
          camera = { ...camera, ...update };
        }),
        render: jest.fn(),
      };
      (getEnabledElement as jest.Mock).mockReturnValue({ viewport });
      const tool = new VolumeRotateTool({ configuration: { rotateIncrementDegrees: 5 } });
      tool.mouseWheelCallback({ detail: { element: {}, wheel: { direction: 1 } } });
      for (let i = 0; i < 3; i++) expect(camera.focalPoint[i]).toBeCloseTo(focalPoint[i], 4);
      expect(camera.position[0] - focalPoint[0]).toBeCloseTo(100 * Math.cos(Math.PI / 36), 3);
      expect(camera.position[1] - focalPoint[1]).toBeCloseTo(100 * Math.sin(Math.PI / 36), 3);
      tool.mouseWheelCallback({ detail: { element: {}, wheel: { direction: -1 } } });
      expect(camera.position[0]).toBeCloseTo(focalPoint[0] + 100, 3);
      expect(camera.position[1]).toBeCloseTo(focalPoint[1], 3);
    }
  );
});
