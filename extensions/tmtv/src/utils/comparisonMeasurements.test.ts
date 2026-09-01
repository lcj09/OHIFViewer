import { cache, getEnabledElement, metaData } from '@cornerstonejs/core';
import { annotation as csAnnotation } from '@cornerstonejs/tools';
import comparisonService from '../services/TMTVComparisonService';
import FrameOfReferenceSpecificAnnotationManager from '@cornerstonejs/tools/stateManagement/annotation/FrameOfReferenceSpecificAnnotationManager';
import getSOPInstanceAttributes from '../../../cornerstone/src/utils/measurementServiceMappings/utils/getSOPInstanceAttributes';
import {
  clearTMTVMeasurements,
  getAnnotationStudyUID,
  getViewportStudyUID,
  installComparisonMeasurementIsolation,
} from './comparisonMeasurements';

jest.mock('@cornerstonejs/core', () => ({
  eventTarget: { addEventListener: jest.fn() },
  Enums: { Events: { IMAGE_VOLUME_MODIFIED: 'volume-modified' } },
  cache: { getVolume: jest.fn() },
  getEnabledElement: jest.fn(),
  metaData: { get: jest.fn() },
}));
jest.mock('@cornerstonejs/tools', () => ({
  annotation: {
    selection: { getAnnotationsSelected: jest.fn(), setAnnotationSelected: jest.fn() },
    state: {
      getAllAnnotations: jest.fn(),
      getAnnotation: jest.fn(),
      removeAnnotation: jest.fn(),
    },
  },
}));
jest.mock('../services/TMTVComparisonService', () => ({
  __esModule: true,
  default: { isComparisonProtocolActive: jest.fn() },
}));

const names = [
  'Length',
  'Bidirectional',
  'ArrowAnnotate',
  'EllipticalROI',
  'RectangleROI',
  'PlanarFreehandROI',
  'CircleROI',
  'SphereROI',
  'Angle',
  'CobbAngle',
  'Probe',
];

function makeAnnotation(uid, study, toolName = 'Length') {
  return {
    annotationUID: uid,
    metadata: { toolName, FrameOfReferenceUID: 'shared-for', referencedImageId: study },
    data: {
      handles: {
        points: [
          [0, 0, 0],
          [10, 0, 0],
        ],
      },
      cachedStats: {},
    },
  };
}

describe('TMTV comparison measurement ownership', () => {
  let servicesManager;
  let commandsManager;
  let displaySets;
  let tools;
  let annotations;
  let measurements;
  let isolation;

  beforeEach(() => {
    jest.resetAllMocks();
    (comparisonService.isComparisonProtocolActive as jest.Mock).mockReturnValue(true);
    (csAnnotation.selection.getAnnotationsSelected as jest.Mock).mockReturnValue([]);
    (metaData.get as jest.Mock).mockImplementation((_module, id) =>
      ['study-a', 'study-b'].includes(id) ? { StudyInstanceUID: id } : undefined
    );
    (getEnabledElement as jest.Mock).mockImplementation(
      element => element && { viewport: { id: element.id } }
    );
    displaySets = {
      baselineCTAxial: [{ StudyInstanceUID: 'study-a' }],
      baselineFusionAxial: [{ StudyInstanceUID: 'study-a' }, { StudyInstanceUID: 'study-a' }],
      followupCTAxial: [{ StudyInstanceUID: 'study-b' }],
    };
    tools = Object.fromEntries(
      names.map(name => [
        name,
        {
          filterInteractableAnnotationsForElement: jest.fn((_element, list) => list),
        },
      ])
    );
    annotations = [makeAnnotation('a', 'study-a'), makeAnnotation('b', 'study-b')];
    measurements = new Map(
      annotations.map(item => [
        item.annotationUID,
        {
          uid: item.annotationUID,
          referenceStudyUID: item.metadata.referencedImageId,
        },
      ])
    );
    (csAnnotation.state.getAllAnnotations as jest.Mock).mockImplementation(() => annotations);
    (csAnnotation.state.getAnnotation as jest.Mock).mockImplementation(uid =>
      annotations.find(item => item.annotationUID === uid)
    );
    (csAnnotation.state.removeAnnotation as jest.Mock).mockImplementation(uid => {
      annotations = annotations.filter(item => item.annotationUID !== uid);
    });
    servicesManager = {
      services: {
        toolGroupService: {
          getToolGroupIds: () => ['ct'],
          getToolGroup: () => ({ _toolInstances: tools }),
        },
        cornerstoneViewportService: {
          getViewportDisplaySets: id => displaySets[id] || [],
          getRenderingEngine: () => ({ render: jest.fn() }),
        },
        viewportGridService: { getState: () => ({ activeViewportId: 'baselineCTAxial' }) },
        measurementService: { getMeasurement: uid => measurements.get(uid) },
        uiNotificationService: { show: jest.fn() },
      },
    };
    commandsManager = {
      runCommand: jest.fn((command, options) => {
        if (command !== 'clearMeasurements') return;
        for (const measurement of [...measurements.values()]) {
          if (!options.measurementFilter || options.measurementFilter(measurement)) {
            measurements.delete(measurement.uid);
            csAnnotation.state.removeAnnotation(measurement.uid);
          }
        }
      }),
    };
  });

  afterEach(() => {
    isolation?.dispose();
    isolation = undefined;
  });

  it.each(names)('%s filters display and hit testing even with a shared FrameOfReference', name => {
    isolation = installComparisonMeasurementIsolation(servicesManager);
    const filter = tools[name].filterInteractableAnnotationsForElement;
    expect(filter({ id: 'baselineCTAxial' }, annotations)).toEqual([annotations[0]]);
    expect(filter({ id: 'followupCTAxial' }, annotations)).toEqual([annotations[1]]);
    expect(filter({ id: 'baselineFusionAxial' }, annotations)).toEqual([annotations[0]]);
    expect(annotations).toHaveLength(2);
  });

  it('editing a visible measurement leaves the opposite study handles and statistics unchanged', () => {
    isolation = installComparisonMeasurementIsolation(servicesManager);
    const before = JSON.stringify(annotations[1]);
    const visible = tools.Length.filterInteractableAnnotationsForElement(
      { id: 'baselineCTAxial' },
      annotations
    );
    visible[0].data.handles.points[1][0] = 20;
    visible[0].data.cachedStats.own = { length: 20 };
    expect(JSON.stringify(annotations[1])).toBe(before);
    expect(visible[0]).toBe(annotations[0]);
  });

  it('isolates annotations returned together by the native shared-frame manager', () => {
    const manager = new FrameOfReferenceSpecificAnnotationManager('test-manager');
    annotations.forEach(item => manager.addAnnotation(item));
    const shared = manager.getAnnotations('shared-for', 'Length');
    expect(shared).toHaveLength(2);
    isolation = installComparisonMeasurementIsolation(servicesManager);
    const visible = tools.Length.filterInteractableAnnotationsForElement(
      { id: 'baselineCTAxial' },
      shared
    );
    expect(visible).toEqual([annotations[0]]);
    manager.removeAnnotation(visible[0].annotationUID);
    expect(manager.getAnnotations('shared-for', 'Length')).toEqual([annotations[1]]);
  });

  it('retains separate study references through the existing OHIF measurement mapping', () => {
    expect(
      getSOPInstanceAttributes(annotations[0].metadata.referencedImageId).StudyInstanceUID
    ).toBe('study-a');
    expect(
      getSOPInstanceAttributes(annotations[1].metadata.referencedImageId).StudyInstanceUID
    ).toBe('study-b');
  });

  it.each(['baselineCTAxial', 'baselineFusionAxial'])(
    'keeps same-study selection and clears the other study before Delete in %s',
    viewportId => {
      servicesManager.services.viewportGridService.getState = () => ({
        activeViewportId: viewportId,
      });
      (csAnnotation.selection.getAnnotationsSelected as jest.Mock).mockReturnValue(['a', 'b']);
      isolation = installComparisonMeasurementIsolation(servicesManager);
      isolation.syncSelection();
      expect(csAnnotation.selection.setAnnotationSelected).toHaveBeenCalledTimes(1);
      expect(csAnnotation.selection.setAnnotationSelected).toHaveBeenCalledWith('b', false);
    }
  );

  it('does not clear selection in ordinary mode or in late callbacks after disposal', () => {
    (csAnnotation.selection.getAnnotationsSelected as jest.Mock).mockReturnValue(['a', 'b']);
    isolation = installComparisonMeasurementIsolation(servicesManager);
    (comparisonService.isComparisonProtocolActive as jest.Mock).mockReturnValue(false);
    isolation.syncSelection();
    (comparisonService.isComparisonProtocolActive as jest.Mock).mockReturnValue(true);
    isolation.dispose();
    isolation.syncSelection();
    expect(csAnnotation.selection.setAnnotationSelected).not.toHaveBeenCalled();
  });

  it('keeps the native slice/plane filter, its receiver and extra arguments', () => {
    tools.Length.filterInteractableAnnotationsForElement = jest.fn(
      function (_element, items, marker) {
        expect(this).toBe(tools.Length);
        expect(marker).toBe('native-options');
        expect(items).toEqual([annotations[0]]);
        return [];
      }
    );
    isolation = installComparisonMeasurementIsolation(servicesManager);
    expect(
      tools.Length.filterInteractableAnnotationsForElement(
        { id: 'baselineCTAxial' },
        annotations,
        'native-options'
      )
    ).toEqual([]);
  });

  it('does not guess ownership for unready viewports or unknown annotations', () => {
    isolation = installComparisonMeasurementIsolation(servicesManager);
    const filter = tools.Length.filterInteractableAnnotationsForElement;
    expect(filter(undefined, annotations)).toEqual([]);
    expect(filter({ id: 'loading' }, annotations)).toEqual([]);
    expect(filter({ id: 'baselineCTAxial' }, undefined)).toEqual([]);
    expect(filter({ id: 'baselineCTAxial' }, [makeAnnotation('unknown', undefined)])).toEqual([]);
  });

  it('uses current display sets after a series replacement, not the comparison side name', () => {
    isolation = installComparisonMeasurementIsolation(servicesManager);
    displaySets.baselineCTAxial = [{ StudyInstanceUID: 'study-b' }];
    expect(
      tools.Length.filterInteractableAnnotationsForElement({ id: 'baselineCTAxial' }, annotations)
    ).toEqual([annotations[1]]);
  });

  it('refuses mixed-study or incomplete fusion data', () => {
    displaySets.baselineFusionAxial[1].StudyInstanceUID = 'study-b';
    expect(getViewportStudyUID(servicesManager, 'baselineFusionAxial')).toBeUndefined();
    displaySets.baselineFusionAxial[1] = {};
    expect(getViewportStudyUID(servicesManager, 'baselineFusionAxial')).toBeUndefined();
  });

  it('resolves MPR annotations from their volume and imported annotations from their own measurement', () => {
    const mpr = { annotationUID: 'mpr', metadata: { volumeId: 'volume-a' } };
    (cache.getVolume as jest.Mock).mockReturnValue({ imageIds: ['study-a'] });
    expect(getAnnotationStudyUID(mpr, servicesManager)).toBe('study-a');
    expect(getAnnotationStudyUID({ annotationUID: 'b', metadata: {} }, servicesManager)).toBe(
      'study-b'
    );
    expect(getAnnotationStudyUID(null, servicesManager)).toBeUndefined();
  });

  it('prefers source image ownership over a stale measurement record', () => {
    measurements.get('a').referenceStudyUID = 'study-b';
    expect(getAnnotationStudyUID(annotations[0], servicesManager)).toBe('study-a');
  });

  it('leaves ordinary TMTV and segmentation/crosshair tools untouched', () => {
    const crosshair = jest.fn((_element, list) => list);
    tools.Crosshairs = { filterInteractableAnnotationsForElement: crosshair };
    tools.RectangleROIStartEndThreshold = { filterInteractableAnnotationsForElement: crosshair };
    isolation = installComparisonMeasurementIsolation(servicesManager);
    (comparisonService.isComparisonProtocolActive as jest.Mock).mockReturnValue(false);
    expect(
      tools.Length.filterInteractableAnnotationsForElement({ id: 'baselineCTAxial' }, annotations)
    ).toBe(annotations);
    expect(tools.Crosshairs.filterInteractableAnnotationsForElement).toBe(crosshair);
    expect(tools.RectangleROIStartEndThreshold.filterInteractableAnnotationsForElement).toBe(
      crosshair
    );
  });

  it('installs once, handles newly created tools and restores all instance methods on repeated disposal', () => {
    const original = tools.Length.filterInteractableAnnotationsForElement;
    const oldTool = tools.Length;
    isolation = installComparisonMeasurementIsolation(servicesManager);
    const wrapped = tools.Length.filterInteractableAnnotationsForElement;
    isolation.refresh();
    expect(tools.Length.filterInteractableAnnotationsForElement).toBe(wrapped);
    const replacement = jest.fn((_element, list) => list);
    tools.Length = { filterInteractableAnnotationsForElement: replacement };
    isolation.refresh();
    expect(tools.Length.filterInteractableAnnotationsForElement).not.toBe(replacement);
    expect(oldTool.filterInteractableAnnotationsForElement).toBe(original);
    isolation.dispose();
    isolation.dispose();
    isolation.refresh();
    expect(tools.Length.filterInteractableAnnotationsForElement).toBe(replacement);
    expect(wrapped({ id: 'baselineCTAxial' }, annotations)).toBe(annotations);
    expect(original).toHaveBeenCalled();
  });

  it('restores inherited filters without leaving an own property', () => {
    tools.Length = Object.create({
      filterInteractableAnnotationsForElement: (_element, list) => list,
    });
    isolation = installComparisonMeasurementIsolation(servicesManager);
    isolation.dispose();
    expect(Object.hasOwn(tools.Length, 'filterInteractableAnnotationsForElement')).toBe(false);
  });

  it.each([false, true])('clears only the selected study with comparison sync=%s', enabled => {
    servicesManager.services.customizationService = {
      getCustomization: () => ({ comparisonStudySync: enabled }),
    };
    clearTMTVMeasurements(servicesManager, commandsManager);
    expect([...measurements.keys()]).toEqual(['b']);
    expect(annotations.map(item => item.annotationUID)).toEqual(['b']);
  });

  it('clears the follow-up side independently and preserves unknown ownership', () => {
    servicesManager.services.viewportGridService.getState = () => ({
      activeViewportId: 'followupCTAxial',
    });
    annotations.push(makeAnnotation('unknown', undefined));
    clearTMTVMeasurements(servicesManager, commandsManager);
    expect(annotations.map(item => item.annotationUID)).toEqual(['a', 'unknown']);
  });

  it('clears unmapped sphere ROI with an undo memo, but never segmentation or opposite annotations', () => {
    annotations.push(makeAnnotation('sphere-a', 'study-a', 'SphereROI'));
    annotations.push(makeAnnotation('sphere-b', 'study-b', 'SphereROI'));
    annotations.push(makeAnnotation('seg', 'study-a', 'RectangleROIStartEndThreshold'));
    clearTMTVMeasurements(servicesManager, commandsManager);
    expect(annotations.map(item => item.annotationUID)).toEqual(['b', 'sphere-b', 'seg']);
    expect(commandsManager.runCommand).toHaveBeenCalledWith(
      'triggerCreateAnnotationMemo',
      expect.objectContaining({
        annotation: expect.objectContaining({ annotationUID: 'sphere-a' }),
        options: { deleting: true },
      })
    );
  });

  it('does not clear anything before current study resolution', () => {
    displaySets.baselineCTAxial = [];
    clearTMTVMeasurements(servicesManager, commandsManager);
    expect(commandsManager.runCommand).not.toHaveBeenCalled();
    expect(servicesManager.services.uiNotificationService.show).toHaveBeenCalled();
    expect(annotations).toHaveLength(2);
  });

  it('retains the ordinary TMTV global clear command', () => {
    (comparisonService.isComparisonProtocolActive as jest.Mock).mockReturnValue(false);
    clearTMTVMeasurements(servicesManager, commandsManager);
    expect(commandsManager.runCommand).toHaveBeenCalledWith('clearMeasurements', {});
    expect(annotations).toEqual([]);
  });
});
