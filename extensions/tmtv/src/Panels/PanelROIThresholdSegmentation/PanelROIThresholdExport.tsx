import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveViewportSegmentationRepresentations } from '@ohif/extension-cornerstone';
import { handleROIThresholding } from '../../utils/handleROIThresholding';
import { debounce } from '@ohif/core/src/utils';
import { useSystem } from '@ohif/core/src';
import { Button } from '@ohif/ui-next';
import tmtvLesionService from '../../services/TMTVLesionService';

const SEGMENT_INDEX = 1;

function formatStat(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

export default function PanelRoiThresholdSegmentation() {
  const { commandsManager, servicesManager } = useSystem();
  const { segmentationService } = servicesManager.services;
  const { segmentationsWithRepresentations: segmentationsInfo } =
    useActiveViewportSegmentationRepresentations();

  const segmentationIds = segmentationsInfo?.map(info => info.segmentation.segmentationId) || [];
  const segmentations = segmentationsInfo?.map(info => info.segmentation) || [];
  const segmentationGroupId = useMemo(
    () => [...segmentationIds].sort().join(','),
    [segmentationsInfo]
  );
  const [lesionState, setLesionState] = useState(() => tmtvLesionService.getState(segmentationIds));

  const refreshTMTVAndLesions = useCallback(
    async (segmentationId?: string) => {
      await handleROIThresholding({
        segmentationId,
        commandsManager,
        segmentationService,
      });

      const currentSegmentations = segmentationIds.length
        ? segmentationIds.map(id => segmentationService.getSegmentation(id)).filter(Boolean)
        : segmentationService.getSegmentations();
      tmtvLesionService.extractLesionsForSegmentations(currentSegmentations, SEGMENT_INDEX);
    },
    [commandsManager, segmentationGroupId, segmentationService]
  );

  useEffect(() => {
    const subscription = tmtvLesionService.subscribe(() => {
      setLesionState(tmtvLesionService.getState(segmentationIds));
    });

    setLesionState(tmtvLesionService.getState(segmentationIds));

    return () => {
      subscription.unsubscribe();
    };
  }, [segmentationGroupId]);

  useEffect(() => {
    const initialRun = async () => {
      if (!segmentationIds.length) {
        return;
      }

      for (const segmentationId of segmentationIds) {
        await refreshTMTVAndLesions(segmentationId);
      }
    };

    initialRun();
  }, [refreshTMTVAndLesions, segmentationGroupId]);

  useEffect(() => {
    const debouncedHandleROIThresholding = debounce(async eventDetail => {
      const { segmentationId } = eventDetail;
      await refreshTMTVAndLesions(segmentationId);
    }, 100);

    const dataModifiedCallback = eventDetail => {
      debouncedHandleROIThresholding(eventDetail);
    };

    const dataModifiedSubscription = segmentationService.subscribe(
      segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
      dataModifiedCallback
    );

    return () => {
      dataModifiedSubscription.unsubscribe();
    };
  }, [refreshTMTVAndLesions, segmentationService]);

  // Find the first segmentation with a TMTV value since all of them have the same value
  const stats = segmentationService.getSegmentationGroupStats(segmentationIds);
  const tmtvValue = stats?.tmtv ?? lesionState.totals.tmtv;
  const tlgValue = lesionState.totals.tlg;
  const lesionCount = lesionState.lesions.length;

  const handleExportCSV = () => {
    if (!segmentations.length) {
      return;
    }

    commandsManager.runCommand('exportTMTVReportCSV', {
      segmentations,
      tmtv: tmtvValue,
      lesions: lesionState.lesions,
      lesionTotals: lesionState.totals,
      config: {},
    });
  };

  return (
    <div className="mb-1 flex flex-col">
      <div className="invisible-scrollbar overflow-y-auto overflow-x-hidden">
        <div className="bg-popover flex items-baseline justify-between px-2 py-1">
          <div className="py-1">
            <span className="text-muted-foreground text-base font-bold uppercase">{'TMTV：'}</span>
            <span className="text-foreground">{tmtvValue ? `${tmtvValue.toFixed(3)} mL` : ''}</span>
            <span className="text-muted-foreground ml-3 text-base font-bold uppercase">
              {'TLG：'}
            </span>
            <span className="text-foreground">{formatStat(tlgValue)}</span>
          </div>
          <div className="flex items-center">
            <Button
              dataCY="exportTmtvCsvReport"
              size="sm"
              variant="ghost"
              onClick={handleExportCSV}
            >
              <span className="pl-1">CSV</span>
            </Button>
          </div>
        </div>
        <div className="bg-background border-border border-t px-2 py-2">
          <div className="text-muted-foreground mb-2 flex items-center justify-between text-xs font-semibold uppercase">
            <span>Lesions</span>
            <span>{lesionCount}</span>
          </div>
          {!lesionCount && (
            <div className="text-muted-foreground py-2 text-sm">No Segment 1 lesions found.</div>
          )}
          {lesionState.lesions.map(lesion => (
            <div
              key={lesion.id}
              className="border-border mb-2 border-b pb-2 last:mb-0 last:border-b-0 last:pb-0"
            >
              <div className="text-foreground mb-1 text-sm font-semibold">
                {`Lesion ${lesion.lesionNumber}`}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">Volume</span>
                <span className="text-foreground text-right">{`${formatStat(lesion.volume)} mL`}</span>
                <span className="text-muted-foreground">SUVmax</span>
                <span className="text-foreground text-right">{formatStat(lesion.suvMax)}</span>
                <span className="text-muted-foreground">SUVmean</span>
                <span className="text-foreground text-right">{formatStat(lesion.suvMean)}</span>
                <span className="text-muted-foreground">TLG</span>
                <span className="text-foreground text-right">{formatStat(lesion.tlg)}</span>
              </div>
            </div>
          ))}
          {!!lesionCount && (
            <div className="border-border mt-2 border-t pt-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total TMTV</span>
                <span className="text-foreground">{`${formatStat(lesionState.totals.tmtv)} mL`}</span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">Total TLG</span>
                <span className="text-foreground">{formatStat(lesionState.totals.tlg)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
