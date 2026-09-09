const wrappedTrackballTools = new WeakSet<object>();

/** 2026-09-02 功能说明：确保 MIP 滚轮只由原生体积旋转占用，保留其他工具的非滚轮绑定。 */
export default function ensureMIPWheelBinding(toolGroupService, toolNames, enums): void {
  const group = toolGroupService?.getToolGroup?.('mipToolGroup');
  if (!group) return;
  const wheel = enums.MouseBindings.Wheel;
  const toolOptions = group.toolOptions || {};

  Object.entries(toolOptions).forEach(([toolName, options]: [string, any]) => {
    if (toolName === toolNames.VolumeRotate) return;
    const wheelBindings = options?.bindings?.filter(binding => binding.mouseButton === wheel) || [];
    if (wheelBindings.length) {
      group.setToolPassive(toolName, { removeAllBindings: wheelBindings });
    }
  });

  releaseMIPTrackballResizeBindings(group, toolNames);

  const rotateOptions = group.getToolOptions?.(toolNames.VolumeRotate);
  if (!rotateOptions) return;
  const hasWheel =
    rotateOptions.mode === enums.ToolModes.Active &&
    rotateOptions.bindings?.some(binding => binding.mouseButton === wheel && !binding.modifierKey);
  if (!hasWheel) {
    group.setToolActive(toolNames.VolumeRotate, { bindings: [{ mouseButton: wheel }] });
  }
}

const disconnectTrackballResizeBindings = tool => {
  try {
    tool.onSetToolDisabled();
  } catch {
    tool._resizeObservers?.forEach?.(observer => observer?.disconnect?.());
    tool._resizeObservers?.clear?.();
    tool._viewportAddedListener = null;
  }
};

/** 2026-09-08 功能说明：每次轨迹球激活后移除尺寸重置监听，避免布局还原时再次重置 MIP 相机。 */
export function releaseMIPTrackballResizeBindings(group, toolNames): void {
  const tool = group?._toolInstances?.[toolNames?.TrackballRotateTool];
  if (!tool || typeof tool.onSetToolDisabled !== 'function') return;

  if (!wrappedTrackballTools.has(tool)) {
    const originalOnSetToolActive = tool.onSetToolActive;
    if (typeof originalOnSetToolActive === 'function') {
      tool.onSetToolActive = (...args) => {
        const result = originalOnSetToolActive.apply(tool, args);
        disconnectTrackballResizeBindings(tool);
        return result;
      };
    }
    wrappedTrackballTools.add(tool);
  }

  disconnectTrackballResizeBindings(tool);
}

/** 2026-08-31 功能说明：对比模式恢复相机同步成员时按原检查分组，MIP 不加入轴位切片组。 */
export function belongsToComparisonCameraGroup(syncId: string, viewportId: string): boolean {
  if (syncId !== 'axialSyncBaseline' && syncId !== 'axialSyncFollowup') return true;
  const side = syncId === 'axialSyncBaseline' ? 'baseline' : 'followup';
  return [`${side}CTAxial`, `${side}PTAxial`, `${side}FusionAxial`].includes(viewportId);
}
