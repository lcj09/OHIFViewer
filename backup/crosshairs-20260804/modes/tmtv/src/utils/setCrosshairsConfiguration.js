import { toolGroupIds } from '../initToolGroups';

export default function setCrosshairsConfiguration(
  matches,
  toolNames,
  toolGroupService,
  displaySetService
) {
  const matchDetails = matches.get('ctDisplaySet');

  if (!matchDetails) {
    return;
  }

  const { SeriesInstanceUID } = matchDetails;
  const displaySets = displaySetService.getDisplaySetsForSeries(SeriesInstanceUID);

  const toolConfig = toolGroupService.getToolConfiguration(
    toolGroupIds.Fusion,
    toolNames.Crosshairs
  );

  const crosshairsConfig = {
    ...toolConfig,
    filterActorUIDsToSetSlabThickness: [displaySets[0].displaySetInstanceUID],
  };

  toolGroupService.setToolConfiguration(
    toolGroupIds.Fusion,
    toolNames.Crosshairs,
    crosshairsConfig
  );

  // [2026-05-19 新增] SingleSliceLine工具也需要相同的配置
  // 原因：在Fusion视口中修改slab厚度时，需要仅影响CT体积，而非同时影响PT和CT
  const singleSliceLineConfig = toolGroupService.getToolConfiguration(
    toolGroupIds.Fusion,
    toolNames.SingleSliceLine
  );

  if (singleSliceLineConfig) {
    toolGroupService.setToolConfiguration(
      toolGroupIds.Fusion,
      toolNames.SingleSliceLine,
      {
        ...singleSliceLineConfig,
        filterActorUIDsToSetSlabThickness: [displaySets[0].displaySetInstanceUID],
      }
    );
  }
}
