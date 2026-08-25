import { cache, Enums as csEnums, volumeLoader } from '@cornerstonejs/core';
import * as csTools from '@cornerstonejs/tools';

import type { TMTVLesion } from './TMTVLesionService';

const { SegmentationRepresentations } = csTools.Enums;
const HIGHLIGHT_SEGMENTATION_ID_PREFIX = 'tmtv-selected-lesion-highlight';
const HIGHLIGHT_SEGMENT_INDEX = 1;
const HIGHLIGHT_COLOR = [255, 0, 255, 255];

type HighlightState = {
  segmentationId: string;
  volumeId: string;
  previousVoxelIndices: number[];
};

class TMTVLesionHighlightService {
  private servicesManager;
  private stateByGroupId = new Map<string, HighlightState>();

  public init(servicesManager): void {
    this.servicesManager = servicesManager;
  }

  public isHighlightSegmentationId(segmentationId?: string): boolean {
    return !!segmentationId && segmentationId.startsWith(HIGHLIGHT_SEGMENTATION_ID_PREFIX);
  }

  public async highlightLesion(
    segmentationIds: string[],
    lesion: TMTVLesion | null
  ): Promise<void> {
    // [2026-08-25 功能] 选中 lesion 时只更新独立高亮 mask，不移动视图、不修改 Segment 1、不影响 TMTV/TLG
    if (!lesion) {
      this.clearHighlight(segmentationIds);
      return;
    }

    const groupId = this.getGroupId(segmentationIds);
    const sourceSegmentationVolumeId = this.getSegmentationVolumeId(lesion.segmentationId);

    if (!sourceSegmentationVolumeId) {
      return;
    }

    const sourceSegmentationVolume = getCachedVolume(sourceSegmentationVolumeId);
    const sourceScalarData = getScalarData(sourceSegmentationVolume);

    if (!sourceSegmentationVolume || !sourceScalarData) {
      return;
    }

    const highlightState = await this.ensureHighlightState(
      groupId,
      sourceSegmentationVolumeId,
      sourceScalarData.length
    );
    const highlightVolume = getCachedVolume(highlightState.volumeId);
    const highlightScalarData = getScalarData(highlightVolume);

    if (!highlightVolume || !highlightScalarData) {
      return;
    }

    this.clearVoxelIndices(
      highlightVolume,
      highlightScalarData,
      highlightState.previousVoxelIndices
    );
    this.setVoxelIndices(
      highlightVolume,
      highlightScalarData,
      lesion.voxelIndices,
      HIGHLIGHT_SEGMENT_INDEX
    );
    highlightState.previousVoxelIndices = lesion.voxelIndices;

    await this.addHighlightToViewports(highlightState.segmentationId, lesion.segmentationId);
    this.renderHighlight(highlightState.segmentationId, highlightVolume, lesion.voxelIndices);
  }

  public clearHighlight(segmentationIds: string[]): void {
    // [2026-08-25 功能] 取消选中时清空高亮层，保留真实 Segment 1 和统计结果不变
    const groupId = this.getGroupId(segmentationIds);
    const highlightState = this.stateByGroupId.get(groupId);

    if (!highlightState) {
      return;
    }

    const highlightVolume = getCachedVolume(highlightState.volumeId);
    const highlightScalarData = getScalarData(highlightVolume);

    if (!highlightVolume || !highlightScalarData) {
      this.removeHighlightFromViewports(highlightState.segmentationId);
      return;
    }

    if (highlightState.previousVoxelIndices.length) {
      this.clearVoxelIndices(
        highlightVolume,
        highlightScalarData,
        highlightState.previousVoxelIndices
      );
      this.renderHighlight(
        highlightState.segmentationId,
        highlightVolume,
        highlightState.previousVoxelIndices
      );
    }

    highlightState.previousVoxelIndices = [];
    this.removeHighlightFromViewports(highlightState.segmentationId);
  }

  public removeHighlight(segmentationIds: string[]): void {
    // [2026-08-25 功能] 面板卸载/返回查询页前移除高亮 representation，避免留下悬挂 actor
    const groupId = this.getGroupId(segmentationIds);
    const highlightState = this.stateByGroupId.get(groupId);

    if (!highlightState) {
      return;
    }

    this.clearHighlight(segmentationIds);
  }

  private async ensureHighlightState(
    groupId: string,
    sourceSegmentationVolumeId: string,
    scalarLength: number
  ): Promise<HighlightState> {
    const existingState = this.stateByGroupId.get(groupId);

    if (existingState && getCachedVolume(existingState.volumeId)) {
      return existingState;
    }

    const segmentationId = `${HIGHLIGHT_SEGMENTATION_ID_PREFIX}:${groupId || sourceSegmentationVolumeId}`;
    const volumeId = `${segmentationId}:volume`;

    if (!getCachedVolume(volumeId)) {
      const highlightVolume = await volumeLoader.createAndCacheDerivedVolume(
        sourceSegmentationVolumeId,
        {
          volumeId,
          targetBuffer: {
            type: 'Uint8Array',
          },
        }
      );
      const emptyScalarData = new Uint8Array(scalarLength);
      highlightVolume.voxelManager?.setCompleteScalarDataArray?.(emptyScalarData);
      highlightVolume.loadStatus = { loaded: true };
    }

    this.registerHighlightSegmentation(segmentationId, volumeId);

    const state = {
      segmentationId,
      volumeId,
      previousVoxelIndices: [],
    };
    this.stateByGroupId.set(groupId, state);

    return state;
  }

  private registerHighlightSegmentation(segmentationId: string, volumeId: string): void {
    const { segmentationService } = this.servicesManager.services;

    if (segmentationService.getSegmentation(segmentationId)) {
      return;
    }

    // [2026-08-25 功能] 高亮层注册为独立 labelmap segmentation，只用于显示当前选中的 lesion
    segmentationService.addOrUpdateSegmentation({
      segmentationId,
      representation: {
        type: SegmentationRepresentations.Labelmap,
        data: {
          volumeId,
        },
      },
      config: {
        label: 'Selected Lesion Highlight',
        segments: {
          [HIGHLIGHT_SEGMENT_INDEX]: {
            label: 'Selected Lesion',
            active: false,
            locked: true,
          },
        },
      },
    });
  }

  private async addHighlightToViewports(
    highlightSegmentationId: string,
    sourceSegmentationId: string
  ): Promise<void> {
    const { cornerstoneViewportService, segmentationService, viewportGridService } =
      this.servicesManager.services;
    const viewportIds =
      cornerstoneViewportService.getViewportIds?.() ??
      viewportGridService.getViewportIds?.() ??
      Array.from(viewportGridService.getState()?.viewports?.keys?.() ?? []);

    for (const viewportId of viewportIds) {
      const sourceRepresentations = segmentationService.getSegmentationRepresentations?.(
        viewportId,
        {
          segmentationId: sourceSegmentationId,
          type: SegmentationRepresentations.Labelmap,
        }
      );

      if (!sourceRepresentations?.length) {
        continue;
      }

      const existingRepresentations = segmentationService.getSegmentationRepresentations?.(
        viewportId,
        {
          segmentationId: highlightSegmentationId,
          type: SegmentationRepresentations.Labelmap,
        }
      );

      if (!existingRepresentations?.length) {
        await segmentationService.addSegmentationRepresentation(viewportId, {
          segmentationId: highlightSegmentationId,
          type: SegmentationRepresentations.Labelmap,
          config: {
            blendMode: csEnums.BlendModes.MAXIMUM_INTENSITY_BLEND,
          },
          suppressEvents: true,
        });
      }

      // [2026-08-25 功能] 高亮层只负责显示，添加后立即恢复真实 Segment 1 为 active，避免 Brush/Eraser 编辑高亮层
      segmentationService.setActiveSegmentation?.(viewportId, sourceSegmentationId);
      segmentationService.setSegmentColor?.(
        viewportId,
        highlightSegmentationId,
        HIGHLIGHT_SEGMENT_INDEX,
        HIGHLIGHT_COLOR
      );
      csTools.segmentation.config.style.setStyle(
        {
          viewportId,
          segmentationId: highlightSegmentationId,
          type: SegmentationRepresentations.Labelmap,
        },
        {
          fillAlpha: 0.85,
          fillAlphaInactive: 0.85,
          outlineWidth: 3,
          outlineWidthInactive: 3,
          outlineOpacity: 1,
          outlineOpacityInactive: 1,
          renderFill: true,
          renderFillInactive: true,
          renderOutline: true,
          renderOutlineInactive: true,
        } as any
      );
    }
  }

  private renderHighlight(segmentationId: string, volume, voxelIndices: number[]): void {
    const dimensions = getDimensions(volume);

    volume.modified?.();
    csTools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(
      segmentationId,
      getModifiedSlices(voxelIndices, dimensions),
      HIGHLIGHT_SEGMENT_INDEX
    );
    this.renderViewports();
  }

  private renderViewports(): void {
    const { cornerstoneViewportService, viewportGridService } = this.servicesManager.services;
    const viewportIds =
      cornerstoneViewportService.getViewportIds?.() ??
      viewportGridService.getViewportIds?.() ??
      Array.from(viewportGridService.getState()?.viewports?.keys?.() ?? []);

    viewportIds.forEach(viewportId => {
      cornerstoneViewportService.getCornerstoneViewport(viewportId)?.render?.();
    });
  }

  private removeHighlightFromViewports(highlightSegmentationId: string): void {
    const { cornerstoneViewportService, segmentationService, viewportGridService } =
      this.servicesManager.services;
    const viewportIds =
      cornerstoneViewportService.getViewportIds?.() ??
      viewportGridService.getViewportIds?.() ??
      Array.from(viewportGridService.getState()?.viewports?.keys?.() ?? []);

    viewportIds.forEach(viewportId => {
      segmentationService.removeRepresentationsFromViewport?.(viewportId, {
        segmentationId: highlightSegmentationId,
        type: SegmentationRepresentations.Labelmap,
      });
      cornerstoneViewportService.getCornerstoneViewport(viewportId)?.render?.();
    });
  }

  private clearVoxelIndices(volume, scalarData: ArrayLike<number>, voxelIndices: number[]): void {
    this.setVoxelIndices(volume, scalarData, voxelIndices, 0);
  }

  private setVoxelIndices(
    volume,
    scalarData: ArrayLike<number>,
    voxelIndices: number[],
    value: number
  ): void {
    voxelIndices.forEach(voxelIndex => {
      setScalarValue(volume, scalarData, voxelIndex, value);
    });
  }

  private getSegmentationVolumeId(segmentationId: string): string | null {
    const segmentation = csTools.segmentation.state.getSegmentation(segmentationId);
    const labelmapData =
      segmentation?.representationData?.[SegmentationRepresentations.Labelmap] ??
      segmentation?.representationData?.Labelmap;

    return (labelmapData as any)?.volumeId ?? null;
  }

  private getGroupId(segmentationIds: string[]): string {
    return [...segmentationIds].sort().join(',');
  }
}

function getCachedVolume(volumeId: string) {
  try {
    return cache.getVolume(volumeId);
  } catch (error) {
    return null;
  }
}

function getScalarData(volume): ArrayLike<number> | null {
  return (
    volume?.voxelManager?.getCompleteScalarDataArray?.() ??
    volume?.voxelManager?.getScalarData?.() ??
    volume?.scalarData ??
    null
  );
}

function setScalarValue(
  volume,
  scalarData: ArrayLike<number>,
  voxelIndex: number,
  value: number
): void {
  if (volume?.voxelManager?.setAtIndex) {
    volume.voxelManager.setAtIndex(voxelIndex, value);
    return;
  }

  (scalarData as number[])[voxelIndex] = value;
}

function getDimensions(volume): [number, number, number] | null {
  const dimensions = volume?.dimensions ?? volume?.imageData?.getDimensions?.();

  if (!dimensions || dimensions.length < 3) {
    return null;
  }

  return [dimensions[0], dimensions[1], dimensions[2]];
}

function getModifiedSlices(
  voxelIndices: number[],
  dimensions: [number, number, number] | null
): number[] | undefined {
  if (!dimensions) {
    return;
  }

  const sliceSize = dimensions[0] * dimensions[1];
  return Array.from(new Set(voxelIndices.map(voxelIndex => Math.floor(voxelIndex / sliceSize))));
}

const tmtvLesionHighlightService = new TMTVLesionHighlightService();

export { HIGHLIGHT_SEGMENTATION_ID_PREFIX };
export default tmtvLesionHighlightService;
