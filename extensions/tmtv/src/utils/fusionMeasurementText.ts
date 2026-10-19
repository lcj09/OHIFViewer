// [2026-07-07 新增] Fusion视口测量结果显示SUV值工具函数
//
// 功能：在Fusion视口上显示测量结果时，同时显示CT值和PT SUV值
// 适用工具：EllipticalROI, RectangleROI, CircleROI, PlanarFreehandROI (Polygon), SphereROI

import {
  ToolGroupManager,
  annotation as csAnnotation,
  utilities as csUtils,
} from '@cornerstonejs/tools';
import { triggerAnnotationRenderForViewportIds } from '@cornerstonejs/tools/utilities';
import {
  cache,
  getRenderingEngines,
  getEnabledElement,
  utilities as csCoreUtils,
} from '@cornerstonejs/core';

const _getViewportsWithVolumeId = csCoreUtils.getViewportsWithVolumeId || csUtils.getViewportsWithVolumeId;
const pendingNativeStatsRecomputes = new WeakSet<object>();

/**
 * 2026-10-19 功能说明：PET 统计缺失时触发 Cornerstone 原生 RectangleROI 统计重算。
 * 不在这里读取体素或自行计算均值、极值、标准差，避免还原布局后的备用公式与原生结果不一致。
 */
function _requestNativePtStatsRecompute(data: any, targetId: string) {
  if (!data || typeof data !== 'object' || pendingNativeStatsRecomputes.has(data)) return;
  pendingNativeStatsRecomputes.add(data);

  setTimeout(() => {
    pendingNativeStatsRecomputes.delete(data);
    try {
      const annotation = csAnnotation.state
        .getAllAnnotations?.()
        ?.find(
          item =>
            item?.data === data ||
            item?.data?.handles === data?.handles ||
            item?.data?.cachedStats === data?.cachedStats
        );
      if (!annotation) {
        console.warn('[TMTV SUV] 原生重算中止：Cornerstone annotation state 中找不到当前测量。', {
          targetId,
        });
        return;
      }
      annotation.invalidated = true;

      const renderingViewports = getRenderingEngines()
        .flatMap(engine => engine.getViewports?.() || [])
        .filter(viewport => viewport?.element);
      const currentVolumeId = targetId?.startsWith('volumeId:')
        ? csCoreUtils.getVolumeId?.(targetId) || targetId.split('?')[0].replace('volumeId:', '')
        : undefined;
      const fallbackViewports = currentVolumeId
        ? _getViewportsWithVolumeId?.(currentVolumeId) || []
        : [];
      const viewports = renderingViewports.length ? renderingViewports : fallbackViewports;
      const getVolumeIds = (viewport: any): string[] => {
        const volumeIds = viewport.getAllVolumeIds?.() || [];
        // 有些 Cornerstone 视口不实现 getAllVolumeIds；从 actor 引用补齐 volumeId。
        for (const actorEntry of viewport.getActors?.() || []) {
          if (actorEntry?.referencedId && !volumeIds.includes(actorEntry.referencedId)) {
            volumeIds.push(actorEntry.referencedId);
          }
        }
        return volumeIds;
      };
      const getModality = (volumeId: string): string =>
        String(cache.getVolume(volumeId)?.metadata?.Modality || '').toUpperCase();
      const ptViewports = viewports
        .map((viewport: any) => {
          const volumeIds = getVolumeIds(viewport);
          const modalities = new Set(volumeIds.map(getModality).filter(Boolean));
          return {
            viewport,
            volumeIds,
            isFusion: modalities.has('CT') && modalities.has('PT'),
            matchesTarget: viewport.getViewReferenceId?.() === targetId,
          };
        })
        .filter((item: any) => item.volumeIds.some((volumeId: string) => getModality(volumeId) === 'PT'))
        // 先选同一 target 的 Fusion 视口，其次任一 Fusion；禁止 MIP/其它切面覆盖同一缓存。
        .sort((a: any, b: any) =>
          Number(b.isFusion && b.matchesTarget) - Number(a.isFusion && a.matchesTarget) ||
          Number(b.isFusion) - Number(a.isFusion) ||
          Number(b.matchesTarget) - Number(a.matchesTarget)
        );
      const selected = ptViewports[0];
      const viewport = selected?.viewport;
      const renderingEngine = viewport?.getRenderingEngine?.();
      const enabledElement = viewport?.element ? getEnabledElement(viewport.element) : undefined;
      const toolGroup = viewport &&
        ToolGroupManager.getToolGroupForViewport?.(viewport.id, renderingEngine?.id);
      const rectangleTool = toolGroup?.getToolInstance?.('RectangleROI') as any;
      const ptVolumeId = selected?.volumeIds.find(volumeId => getModality(volumeId) === 'PT');

      if (!selected || !rectangleTool || !enabledElement || !renderingEngine || !ptVolumeId) {
        console.warn('[TMTV SUV] 原生重算中止：没有找到可用于统计的 PT/Fusion 视口或 RectangleROI 工具。', {
          targetId,
          candidateViewports: ptViewports.map(({ viewport: candidate, isFusion, matchesTarget }) => ({
            viewportId: candidate.id,
            isFusion,
            matchesTarget,
            toolGroupId: ToolGroupManager.getToolGroupForViewport?.(
              candidate.id,
              candidate.getRenderingEngine?.()?.id
            )?.id,
          })),
        });
        return;
      }

      {
        const ptTargetId = `volumeId:${ptVolumeId}`;
        const ptVolume = cache.getVolume(ptVolumeId);
        if (!ptVolume?.imageData || !ptVolume?.voxelManager) {
          console.warn('[TMTV SUV] 原生重算中止：PT volume 缺少 imageData 或 voxelManager。', {
            targetId,
            ptTargetId,
            viewportId: viewport.id,
          });
          return;
        }

        // Cornerstone 4.21.2 只遍历已有的 cachedStats key；先添加 PT key，再调用原生统计。
        if (!data.cachedStats[ptTargetId]) {
          data.cachedStats[ptTargetId] = { Modality: 'PT', areaUnit: null };
        }
        annotation.invalidated = true;
        const camera = viewport.getCamera?.() || {};
        // 2026-10-19 原生按 targetId 查找 imageData；Fusion 的第一个匹配视口可能返回 CT 主 actor。
        // 仅在同步调用期间把 PT target 指向 PT volume 本身，确保仍走原生统计算法且不串入 CT 像素。
        const originalOwnMethod = Object.getOwnPropertyDescriptor(
          rectangleTool,
          'getTargetImageData'
        );
        const originalGetTargetImageData = rectangleTool.getTargetImageData;
        rectangleTool.getTargetImageData = (requestedTargetId: string) => {
          const requestedVolumeId = requestedTargetId?.startsWith('volumeId:')
            ? csCoreUtils.getVolumeId?.(requestedTargetId) ||
              requestedTargetId.split('?')[0].replace('volumeId:', '')
            : undefined;
          return requestedVolumeId === ptVolumeId
            ? ptVolume
            : originalGetTargetImageData.call(rectangleTool, requestedTargetId);
        };
        try {
          rectangleTool._calculateCachedStats?.(
            annotation,
            camera.viewPlaneNormal,
            camera.viewUp,
            renderingEngine,
            enabledElement
          );
        } finally {
          if (originalOwnMethod) {
            Object.defineProperty(rectangleTool, 'getTargetImageData', originalOwnMethod);
          } else {
            delete rectangleTool.getTargetImageData;
          }
        }
        const ptStats = data.cachedStats[ptTargetId];
        if (ptStats?.Modality !== 'PT' || ptStats?.mean == null || ptStats?.max == null) {
          console.warn('[TMTV SUV] Cornerstone 原生重算没有产生有效 PT 统计。', {
            targetId,
            ptTargetId,
            stats: ptStats,
            viewportId: viewport.id,
          });
        }
        triggerAnnotationRenderForViewportIds([viewport.id]);
        viewport.render?.();
      }
    } catch (error) {
      console.error('[TMTV SUV] 原生重算发生异常，当前不能确认 PT 统计已更新。', error);
    }
  }, 0);
}

/**
 * 2026-10-19 功能说明：兼容 Cornerstone 不同版本的 cachedStats 格式，按 key 对应 volume 识别 PT。
 */
function _getStatsModality(targetId: string, stats: any): string | undefined {
  if (stats?.Modality) return String(stats.Modality).toUpperCase();
  if (!targetId?.startsWith('volumeId:')) return undefined;
  const volumeId = csCoreUtils.getVolumeId?.(targetId) || targetId.split('?')[0].replace('volumeId:', '');
  return String(cache.getVolume(volumeId)?.metadata?.Modality || '').toUpperCase() || undefined;
}

/**
 * 2026-10-19 功能说明：返回缓存中 PT 统计及其真实 targetId，避免当前渲染 targetId 指向 CT 时误读 CT 条目。
 */
function _findPtStats(cachedStats: Record<string, any>) {
  return Object.entries(cachedStats || {}).find(
    ([targetId, stats]) => _getStatsModality(targetId, stats) === 'PT'
  );
}

/**
 * 包装getTextLines函数，在原有文本基础上添加SUV值（从cachedStats中获取PT volume的统计）
 *
 * 原理：
 * - 在Fusion视口中，_calculateCachedStats会为每个volume（CT和PT）分别计算stats
 * - cachedStats对象包含所有volume的统计，key为volumeId
 * - 当渲染CT layer时，targetId对应CT volume，此时可从cachedStats中找到PT volume的entry并读取SUV值
 * - [2026-10-19 修复] 双击还原后PT视口重建导致cachedStats缺少PT entry时，
 *   触发Cornerstone原生RectangleROI重新计算，不在此处自行计算体素统计。
 *
 * @param originalGetTextLines 原始的getTextLines函数
 * @returns 新的getTextLines函数，会在Fusion视口中自动添加SUV值
 */
export function wrapGetTextLinesWithSUV(originalGetTextLines: Function) {
  return function (data: any, targetId: string) {
    const { cachedStats } = data;
    if (!cachedStats) {
      const lines = originalGetTextLines(data, targetId);
      return Array.isArray(lines) ? lines : [];
    }

    // 2026-10-19 功能说明：按项目实际 Cornerstone 4.21.2 的单个 targetId 判断当前视口模态。
    const isPTViewport = _getStatsModality(targetId, cachedStats[targetId]) === 'PT';

    // PT视口：显示原始默认文本（Area/Mean/Max/Min/StdDev + SUV单位），不额外添加SUV行
    if (isPTViewport) {
      // 检查cachedStats中是否有PT entry，没有则请求Cornerstone原生工具重算。
      const ptStatsEntry = _findPtStats(cachedStats);
      if (!ptStatsEntry) {
        _requestNativePtStatsRecompute(data, targetId);
      }
      const lines = originalGetTextLines(data, targetId);
      return Array.isArray(lines) ? lines : [];
    }

    // 非PT视口（Fusion/CT）：显示原始文本 + 额外SUV值
    const textLines = originalGetTextLines(data, targetId);
    const safeTextLines = Array.isArray(textLines) ? textLines : [];

    // 查找PT volume的stats（Modality === 'PT'）
    const ptStatsEntry = _findPtStats(cachedStats);
    let ptStats = ptStatsEntry?.[1];

    // 2026-10-19 如果cachedStats中没有PT stats，触发原生工具重新计算
    if (!ptStats) {
      _requestNativePtStatsRecompute(data, targetId);
    }

    // 如果没有找到PT stats，返回原始文本
    if (!ptStats) return safeTextLines;

    // 检查PT stats是否有有效的SUV值
    const suvMax = ptStats.max ?? ptStats.suvMax;
    const suvMin = ptStats.min ?? ptStats.suvMin;
    const suvMean = ptStats.mean ?? ptStats.suvMean;

    if (suvMin == null && suvMax == null && suvMean == null) return safeTextLines;

    // 添加SUV值到文本
    const suvLines: string[] = [];
    if (suvMax != null) suvLines.push(`SUV Max: ${csUtils.roundNumber(suvMax)}`);
    if (suvMin != null) suvLines.push(`SUV Min: ${csUtils.roundNumber(suvMin)}`);
    if (suvMean != null) suvLines.push(`SUV Mean: ${csUtils.roundNumber(suvMean)}`);

    return [...safeTextLines, ...suvLines];
  };
}
