// [2026-07-07 新增] Fusion视口测量结果显示SUV值工具函数
//
// 功能：在Fusion视口上显示测量结果时，同时显示CT值和PT SUV值
// 适用工具：EllipticalROI, RectangleROI, CircleROI, PlanarFreehandROI (Polygon), SphereROI

import { utilities as csUtils } from '@cornerstonejs/tools';
import { cache, utilities as csCoreUtils } from '@cornerstonejs/core';

const _getViewportsWithVolumeId = csCoreUtils.getViewportsWithVolumeId || csUtils.getViewportsWithVolumeId;

/**
 * 2026-10-16 功能说明：从Fusion视口的actors中查找PT volume的imageData并计算SUV统计值。
 * 当cachedStats中缺少PT entry时（如双击还原后PT视口重建导致annotation未在PT视口渲染），
 * 主动从当前视口查找PT volume并计算统计值。
 */
function _calculatePtStatsFromViewport(data: any, targetId: string) {
  try {
    // 从targetId提取volumeId（当前视口渲染的volume，可能是CT或PT）
    if (!targetId || !targetId.startsWith('volumeId:')) return null;
    const currentVolumeId = csCoreUtils.getVolumeId?.(targetId) || targetId.split('?')[0].replace('volumeId:', '');

    // 获取所有持有当前volume的视口
    const viewports = _getViewportsWithVolumeId?.(currentVolumeId) || [];
    if (viewports.length === 0) return null;

    // 遍历所有视口，查找PT volume
    const ptVolumeIds = new Set();
    for (const viewport of viewports) {
      const actorEntries = viewport.getActors?.();
      if (!actorEntries) continue;

      for (const actorEntry of actorEntries) {
        if (actorEntry.actor.getClassName() !== 'vtkVolume') continue;
        const volId = actorEntry.referencedId || actorEntry.uid;
        if (!volId || volId === currentVolumeId) continue;

        const vol = cache.getVolume(volId);
        if (vol?.metadata?.Modality === 'PT') {
          ptVolumeIds.add(volId);
        }
      }
    }

    // 如果当前volume本身就是PT，也加入候选
    const currentVol = cache.getVolume(currentVolumeId);
    if (currentVol?.metadata?.Modality === 'PT') {
      ptVolumeIds.add(currentVolumeId);
    }

    if (ptVolumeIds.size === 0) return null;

    // 对每个PT volume计算统计值
    for (const ptVolumeId of ptVolumeIds) {
      const ptVolume = cache.getVolume(ptVolumeId);
      if (!ptVolume) continue;

      // 计算PT volume的统计值
      const { imageData, dimensions, voxelManager } = ptVolume;
      const worldHandles = data.handles.points;
      const indexHandles = worldHandles.map((worldHandle) =>
        csCoreUtils.transformWorldToIndex(imageData, worldHandle)
      );

      const pos1Index = indexHandles[0].map(Math.floor);
      const pos2Index = indexHandles[3].map(Math.floor);

      // 检查是否在volume范围内
      const iMin = Math.max(0, Math.min(pos1Index[0], pos2Index[0]));
      const iMax = Math.min(dimensions[0] - 1, Math.max(pos1Index[0], pos2Index[0]));
      const jMin = Math.max(0, Math.min(pos1Index[1], pos2Index[1]));
      const jMax = Math.min(dimensions[1] - 1, Math.max(pos1Index[1], pos2Index[1]));
      const kMin = Math.max(0, Math.min(pos1Index[2], pos2Index[2]));
      const kMax = Math.min(dimensions[2] - 1, Math.max(pos1Index[2], pos2Index[2]));

      if (iMin > iMax || jMin > jMax || kMin > kMax) continue;

      const boundsIJK = [
        [iMin, iMax],
        [jMin, jMax],
        [kMin, kMax],
      ];

      // 2026-10-16 使用voxelManager.forEach遍历计算统计值
      // 注意：voxelManager.forEach的回调签名是({value, index, point})，不是直接(value)
      let max = -Infinity, min = Infinity, sum = 0, count = 0;
      const statsCallback = ({ value }) => {
        if (value == null || isNaN(value)) return;
        if (value > max) max = value;
        if (value < min) min = value;
        sum += value;
        count++;
      };
      voxelManager.forEach(statsCallback, { boundsIJK, imageData });

      if (count === 0) continue;

      return {
        Modality: 'PT',
        max: max === -Infinity ? null : max,
        min: min === Infinity ? null : min,
        mean: sum / count,
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 包装getTextLines函数，在原有文本基础上添加SUV值（从cachedStats中获取PT volume的统计）
 *
 * 原理：
 * - 在Fusion视口中，_calculateCachedStats会为每个volume（CT和PT）分别计算stats
 * - cachedStats对象包含所有volume的统计，key为volumeId
 * - 当渲染CT layer时，targetId对应CT volume，此时可从cachedStats中找到PT volume的entry并读取SUV值
 * - [2026-10-16 修复] 双击还原后PT视口重建，annotation未在PT视口渲染导致cachedStats缺少PT entry，
 *   此时主动从Fusion视口的actors中查找PT volume并计算统计值
 *
 * @param originalGetTextLines 原始的getTextLines函数
 * @returns 新的getTextLines函数，会在Fusion视口中自动添加SUV值
 */
export function wrapGetTextLinesWithSUV(originalGetTextLines: Function) {
  return function (data: any, targetId: string) {
    // 调用原始getTextLines获取基础文本
    const textLines = originalGetTextLines(data, targetId);

    const { cachedStats } = data;
    if (!cachedStats) return textLines;

    // 查找PT volume的stats（Modality === 'PT'）
    let ptStats = null;
    for (const key of Object.keys(cachedStats)) {
      const stats = cachedStats[key];
      if (stats?.Modality === 'PT') {
        ptStats = stats;
        break;
      }
    }

    // 2026-10-16 如果cachedStats中没有PT stats，尝试从视口主动计算
    if (!ptStats) {
      ptStats = _calculatePtStatsFromViewport(data, targetId);
    }

    // 如果没有找到PT stats，返回原始文本
    if (!ptStats) return textLines;

    // 检查PT stats是否有有效的SUV值
    const suvMax = ptStats.max ?? ptStats.suvMax;
    const suvMin = ptStats.min ?? ptStats.suvMin;
    const suvMean = ptStats.mean ?? ptStats.suvMean;

    if (suvMin == null && suvMax == null && suvMean == null) return textLines;

    // 添加SUV值到文本
    const suvLines: string[] = [];
    if (suvMax != null) suvLines.push(`SUV Max: ${csUtils.roundNumber(suvMax)}`);
    if (suvMin != null) suvLines.push(`SUV Min: ${csUtils.roundNumber(suvMin)}`);
    if (suvMean != null) suvLines.push(`SUV Mean: ${csUtils.roundNumber(suvMean)}`);

    return [...textLines, ...suvLines];
  };
}
