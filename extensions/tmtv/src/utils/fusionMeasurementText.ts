// [2026-07-07 新增] Fusion视口测量结果显示SUV值工具函数
//
// 功能：在Fusion视口上显示测量结果时，同时显示CT值和PT SUV值
// 适用工具：EllipticalROI, RectangleROI, CircleROI, PlanarFreehandROI (Polygon), SphereROI

import { utilities as csUtils } from '@cornerstonejs/tools';

/**
 * 包装getTextLines函数，在原有文本基础上添加SUV值（从cachedStats中获取PT volume的统计）
 * 
 * 原理：
 * - 在Fusion视口中，_calculateCachedStats会为每个volume（CT和PT）分别计算stats
 * - cachedStats对象包含所有volume的统计，key为volumeId
 * - 当渲染CT layer时，targetId对应CT volume，此时可从cachedStats中找到PT volume的entry并读取SUV值
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
    
    // 如果没有找到PT stats，说明不是Fusion视口或PT数据不可用
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
