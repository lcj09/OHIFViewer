import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveViewportSegmentationRepresentations } from '@ohif/extension-cornerstone';
import { handleROIThresholding } from '../../utils/handleROIThresholding';
import { debounce } from '@ohif/core/src/utils';
import { useSystem } from '@ohif/core/src';
import { Button } from '@ohif/ui-next';
import tmtvLesionService from '../../services/TMTVLesionService';
import tmtvLesionHighlightService from '../../services/TMTVLesionHighlightService';

const SEGMENT_INDEX = 1;

function formatStat(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

export default function PanelRoiThresholdSegmentation() {
  const { commandsManager, servicesManager } = useSystem();
  const { segmentationService } = servicesManager.services;
  const { segmentationsWithRepresentations: segmentationsInfo } =
    useActiveViewportSegmentationRepresentations();

  // [2026-08-25 功能] 右侧统计只处理真实 TMTV Segment 1，排除“选中 lesion 高亮层”
  const tmtvSegmentationsInfo =
    segmentationsInfo?.filter(
      info =>
        !tmtvLesionHighlightService.isHighlightSegmentationId(info.segmentation.segmentationId)
    ) || [];
  const segmentationIds = tmtvSegmentationsInfo.map(info => info.segmentation.segmentationId);
  const segmentations = tmtvSegmentationsInfo.map(info => info.segmentation);
  const segmentationGroupId = useMemo(
    () => [...segmentationIds].sort().join(','),
    [segmentationsInfo]
  );
  const [lesionState, setLesionState] = useState(() => tmtvLesionService.getState(segmentationIds));

  const refreshTMTVAndLesions = useCallback(
    async (segmentationId?: string) => {
      // [2026-08-24 功能] Segment 1 更新后同步刷新整体 TMTV/TLG 和 lesion 级统计
      const currentSegmentations = segmentationIds.length
        ? segmentationIds.map(id => segmentationService.getSegmentation(id)).filter(Boolean)
        : segmentationService
            .getSegmentations()
            .filter(
              segmentation =>
                !tmtvLesionHighlightService.isHighlightSegmentationId(segmentation.segmentationId)
            );

      await handleROIThresholding({
        segmentationId,
        commandsManager,
        segmentationService,
        segmentations: currentSegmentations,
      });

      tmtvLesionService.extractLesionsForSegmentations(currentSegmentations, SEGMENT_INDEX);
    },
    [commandsManager, segmentationGroupId, segmentationService]
  );

  useEffect(() => {
    // [2026-08-24 功能] 订阅 TMTVLesionService 状态，让右侧 lesion 面板响应选中/删除/重算
    const subscription = tmtvLesionService.subscribe(() => {
      setLesionState(tmtvLesionService.getState(segmentationIds));
    });

    setLesionState(tmtvLesionService.getState(segmentationIds));

    return () => {
      subscription.unsubscribe();
      tmtvLesionHighlightService.removeHighlight(segmentationIds);
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
      if (tmtvLesionHighlightService.isHighlightSegmentationId(eventDetail.segmentationId)) {
        return;
      }

      if (segmentationIds.length && !segmentationIds.includes(eventDetail.segmentationId)) {
        return;
      }

      if (tmtvLesionService.consumeSkipNextFullRefresh(eventDetail.segmentationId)) {
        return;
      }

      debouncedHandleROIThresholding(eventDetail);
    };

    const dataModifiedSubscription = segmentationService.subscribe(
      segmentationService.EVENTS.SEGMENTATION_DATA_MODIFIED,
      dataModifiedCallback
    );

    return () => {
      // [2026-08-25 功能] 面板卸载时清理 debounce timeout，避免切换面板后延迟刷新造成额外计算/潜在泄漏
      debouncedHandleROIThresholding.clearDebounceTimeout?.();
      dataModifiedSubscription.unsubscribe();
    };
  }, [refreshTMTVAndLesions, segmentationService]);

  // [2026-08-25 功能] Header TMTV 以 lesion totals 为准，即所有 3D connected lesion volume 的累加值
  const tmtvValue = lesionState.totals.tmtv;
  const tlgValue = lesionState.totals.tlg;
  const lesionCount = lesionState.lesions.length;
  const selectedLesionId = lesionState.selectedLesionId;

  const handleSelectLesion = lesionId => {
    // [2026-08-25 功能] 点击 lesion 后只触发右侧选中和图像高亮，不执行视图定位
    const nextLesionId = selectedLesionId === lesionId ? null : lesionId;

    commandsManager.runCommand('selectTMTVLesion', {
      segmentationIds,
      lesionId: nextLesionId,
    });
  };

  const handleDeleteLesion = async (event, lesionId) => {
    // [2026-08-24 功能] 删除单个 lesion，对应 voxel 会从 Segment 1 中移除
    event.stopPropagation();
    commandsManager.runCommand('deleteTMTVLesion', {
      segmentationIds,
      lesionId,
    });
  };

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
    <div className="mb-2 flex min-h-0 flex-col">
      {/* [2026-08-25 功能] 右侧 lesion 区域限制高度并显示滚动条，避免遮挡下方分割工具 */}
      <div className="bg-background flex max-h-[36vh] min-h-[120px] flex-col overflow-hidden">
        <div className="bg-popover flex flex-shrink-0 items-baseline justify-between px-2 py-1">
          <div className="py-1">
            <span className="text-muted-foreground text-base font-bold uppercase">{'TMTV：'}</span>
            <span className="text-foreground">{`${formatStat(tmtvValue)} mL`}</span>
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
        <div className="border-border flex flex-shrink-0 items-center justify-between border-t px-2 py-2">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-semibold uppercase">
            <span>Lesions</span>
            <span>{lesionCount}</span>
          </div>
        </div>
        <div className="ohif-scrollbar ohif-scrollbar-stable-gutter min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-2">
          {!lesionCount && (
            <div className="text-muted-foreground py-2 text-sm">No Segment 1 lesions found.</div>
          )}
          {lesionState.lesions.map(lesion => {
            const isSelected = lesion.id === selectedLesionId;

            return (
              <div
                key={lesion.id}
                role="button"
                tabIndex={0}
                className={`border-border mb-2 w-full border-b pb-2 text-left last:mb-0 last:border-b-0 last:pb-0 ${
                  isSelected ? 'bg-primary/10 ring-primary/60 rounded-sm ring-1' : ''
                }`}
                onClick={() => handleSelectLesion(lesion.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    handleSelectLesion(lesion.id);
                  }
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-2 px-1 pt-1">
                  <div className="text-foreground text-sm font-semibold">
                    {`${isSelected ? '★ ' : ''}Lesion ${lesion.lesionNumber}`}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={event => handleDeleteLesion(event, lesion.id)}
                  >
                    Delete
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 pb-1 text-xs">
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
            );
          })}
        </div>
      </div>
    </div>
  );
}
