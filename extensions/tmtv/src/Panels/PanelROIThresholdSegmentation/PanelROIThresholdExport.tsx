import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveViewportSegmentationRepresentations } from '@ohif/extension-cornerstone';
import { handleROIThresholding } from '../../utils/handleROIThresholding';
import { debounce } from '@ohif/core/src/utils';
import { useSystem } from '@ohif/core/src';
import { Button } from '@ohif/ui-next';
import { useTranslation } from 'react-i18next';
import tmtvLesionService from '../../services/TMTVLesionService';
import tmtvLesionHighlightService from '../../services/TMTVLesionHighlightService';

const SEGMENT_INDEX = 1;

function formatStat(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '';
}

export default function PanelRoiThresholdSegmentation() {
  const { t } = useTranslation('ROIThresholdConfiguration');
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

      const nextLesionState = tmtvLesionService.extractLesionsForSegmentations(
        currentSegmentations,
        SEGMENT_INDEX
      );

      // [2026-08-25 功能] Brush/Eraser 修改 Segment 1 后同步刷新 confirmed totals，避免分割已清空但 TMTV/TLG 仍显示旧值
      segmentationService.setSegmentationGroupStats(nextLesionState.segmentationIds, {
        tmtv: nextLesionState.totals.tmtv,
        tlg: nextLesionState.totals.tlg,
      });

      // [2026-08-25 功能] 第二阶段编辑后重建 lesion 时同步更新选中高亮层，避免橡皮擦后仍显示旧 mask
      const selectedLesion =
        nextLesionState.lesions.find(lesion => lesion.id === nextLesionState.selectedLesionId) ??
        null;
      await tmtvLesionHighlightService.highlightLesion(
        nextLesionState.segmentationIds,
        selectedLesion
      );
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

  // [2026-08-25 功能] 第一阶段 Header TMTV/TLG 只统计 confirmed lesions，candidate/rejected 不进入总量
  const tmtvValue = lesionState.totals.tmtv;
  const tlgValue = lesionState.totals.tlg;
  const lesionCount = lesionState.lesions.length;
  const selectedLesionId = lesionState.selectedLesionId;
  const confirmedCount = lesionState.lesions.filter(lesion => lesion.status === 'confirmed').length;
  const rejectedCount = lesionState.lesions.filter(lesion => lesion.status === 'rejected').length;

  const handleSelectLesion = lesionId => {
    // [2026-08-25 功能] 点击 lesion 后只触发右侧选中和图像高亮，不执行视图定位
    const nextLesionId = selectedLesionId === lesionId ? null : lesionId;

    commandsManager.runCommand('selectTMTVLesion', {
      segmentationIds,
      lesionId: nextLesionId,
    });
  };

  const handleSetLesionStatus = (event, lesionId, status) => {
    // [2026-08-25 功能] 第一阶段 Confirm/Reject/Restore 只改变 lesion 业务状态，不物理删除 voxel
    event.stopPropagation();
    commandsManager.runCommand('setTMTVLesionStatus', {
      segmentationIds,
      lesionId,
      status,
    });
  };

  const handleDeleteLesion = (event, lesionId) => {
    // [2026-08-25 功能] 第二阶段 Delete 才真实修改 Segment 1 voxel；仅从 rejected lesion 暴露，避免误删
    event.stopPropagation();

    const shouldDelete =
      typeof window === 'undefined' ||
      window.confirm?.(
        t('Delete rejected lesion confirmation', {
          defaultValue: 'Delete this rejected lesion from Segment 1? This cannot be restored.',
        })
      );

    if (!shouldDelete) {
      return;
    }

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

  const getStatusLabel = status => {
    if (status === 'confirmed') {
      return `✓ ${t('Confirmed', { defaultValue: 'Confirmed' })}`;
    }

    if (status === 'rejected') {
      return `× ${t('Rejected', { defaultValue: 'Rejected' })}`;
    }

    return t('Candidate', { defaultValue: 'Candidate' });
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
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs font-semibold uppercase">
            <span>{t('Lesions', { defaultValue: 'Lesions' })}</span>
            <span>{lesionCount}</span>
            <span>{`${t('Confirmed', { defaultValue: 'Confirmed' })} ${confirmedCount}`}</span>
            <span>{`${t('Rejected', { defaultValue: 'Rejected' })} ${rejectedCount}`}</span>
          </div>
        </div>
        <div className="ohif-scrollbar ohif-scrollbar-stable-gutter min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-2">
          {!lesionCount && (
            <div className="text-muted-foreground py-2 text-sm">
              {t('No Segment 1 lesions found.', {
                defaultValue: 'No Segment 1 lesions found.',
              })}
            </div>
          )}
          {lesionState.lesions.map(lesion => {
            const isSelected = lesion.id === selectedLesionId;
            const isConfirmed = lesion.status === 'confirmed';
            const isRejected = lesion.status === 'rejected';

            return (
              <div
                key={lesion.id}
                role="button"
                tabIndex={0}
                className={`border-border mb-2 w-full border-b pb-2 text-left last:mb-0 last:border-b-0 last:pb-0 ${
                  isSelected ? 'bg-primary/10 ring-primary/60 rounded-sm ring-1' : ''
                } ${isRejected ? 'opacity-45' : ''}`}
                onClick={() => handleSelectLesion(lesion.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    handleSelectLesion(lesion.id);
                  }
                }}
              >
                <div className="mb-1 flex items-start justify-between gap-2 px-1 pt-1">
                  <div>
                    <div className="text-foreground text-sm font-semibold">
                      {`${isSelected ? '★ ' : ''}${t('Lesion', {
                        defaultValue: 'Lesion',
                      })} ${lesion.lesionNumber}`}
                    </div>
                    <div
                      className={`mt-0.5 text-[11px] font-semibold uppercase ${
                        isConfirmed
                          ? 'text-green-400'
                          : isRejected
                            ? 'text-red-400'
                            : 'text-muted-foreground'
                      }`}
                    >
                      <span>{getStatusLabel(lesion.status)}</span>
                      {lesion.modified && (
                        <span className="text-primary ml-2">
                          {t('Edited', { defaultValue: 'Edited' })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {!isConfirmed && !isRejected && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={event => handleSetLesionStatus(event, lesion.id, 'confirmed')}
                        >
                          {t('Confirm', { defaultValue: 'Confirm' })}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={event => handleSetLesionStatus(event, lesion.id, 'rejected')}
                        >
                          {t('Reject', { defaultValue: 'Reject' })}
                        </Button>
                      </>
                    )}
                    {isConfirmed && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={event => handleSetLesionStatus(event, lesion.id, 'rejected')}
                      >
                        {t('Reject', { defaultValue: 'Reject' })}
                      </Button>
                    )}
                    {isRejected && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={event => handleSetLesionStatus(event, lesion.id, 'candidate')}
                        >
                          {t('Restore', { defaultValue: 'Restore' })}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={event => handleDeleteLesion(event, lesion.id)}
                        >
                          {t('Delete', { defaultValue: 'Delete' })}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 pb-1 text-xs">
                  <span className="text-muted-foreground">
                    {t('Volume', { defaultValue: 'Volume' })}
                  </span>
                  <span className="text-foreground text-right">{`${formatStat(lesion.volume)} mL`}</span>
                  <span className="text-muted-foreground">
                    {t('SUVmax', { defaultValue: 'SUVmax' })}
                  </span>
                  <span className="text-foreground text-right">{formatStat(lesion.suvMax)}</span>
                  <span className="text-muted-foreground">
                    {t('SUVmean', { defaultValue: 'SUVmean' })}
                  </span>
                  <span className="text-foreground text-right">{formatStat(lesion.suvMean)}</span>
                  <span className="text-muted-foreground">{t('TLG', { defaultValue: 'TLG' })}</span>
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
