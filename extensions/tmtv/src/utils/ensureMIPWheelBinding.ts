/** 2026-08-31 功能说明：确保 MIP 滚轮使用原生体积旋转，只移除切片滚轮绑定，保留左键工具。 */
export default function ensureMIPWheelBinding(toolGroupService, toolNames, enums): void {
  const group = toolGroupService?.getToolGroup?.('mipToolGroup');
  if (!group) return;
  const wheel = enums.MouseBindings.Wheel;
  const scrollOptions = group.getToolOptions?.(toolNames.StackScroll);
  const wheelBindings =
    scrollOptions?.bindings?.filter(binding => binding.mouseButton === wheel) || [];
  if (wheelBindings.length) {
    group.setToolPassive(toolNames.StackScroll, { removeAllBindings: wheelBindings });
  }
  const rotateOptions = group.getToolOptions?.(toolNames.VolumeRotate);
  if (!rotateOptions) return;
  const hasWheel =
    rotateOptions.mode === enums.ToolModes.Active &&
    rotateOptions.bindings?.some(binding => binding.mouseButton === wheel && !binding.modifierKey);
  if (!hasWheel) {
    group.setToolActive(toolNames.VolumeRotate, { bindings: [{ mouseButton: wheel }] });
  }
}

/** 2026-08-31 功能说明：对比模式恢复相机同步成员时按原检查分组，MIP 不加入轴位切片组。 */
export function belongsToComparisonCameraGroup(syncId: string, viewportId: string): boolean {
  if (syncId !== 'axialSyncBaseline' && syncId !== 'axialSyncFollowup') return true;
  const side = syncId === 'axialSyncBaseline' ? 'baseline' : 'followup';
  return [`${side}CTAxial`, `${side}PTAxial`, `${side}FusionAxial`].includes(viewportId);
}
