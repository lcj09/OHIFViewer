import React, { useCallback, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Button } from '@ohif/ui-next';
import tmtvComparisonService from '../services/TMTVComparisonService';
import type { TMTVComparisonSide } from '../services/TMTVComparisonService';

const SIDE_LABELS: Record<TMTVComparisonSide, string> = {
  baseline: '首次检查',
  followup: '随访检查',
};

/**
 * 2026-08-31 功能说明：对比模式下切换当前操作的 Baseline/Follow-up 检查侧。
 */
function ComparisonSideSelector({ servicesManager }) {
  const [comparisonState, setComparisonState] = useState(() => tmtvComparisonService.getState());

  useEffect(() => {
    if (!servicesManager) {
      return;
    }

    tmtvComparisonService.syncFromActiveViewport(servicesManager);
    const subscription = tmtvComparisonService.subscribe(state => {
      setComparisonState(state);
    });

    return () => {
      try {
        subscription.unsubscribe();
      } catch {
        // ignore cleanup errors
      }
    };
  }, [servicesManager]);

  const handleSelectSide = useCallback((side: TMTVComparisonSide) => {
    tmtvComparisonService.setActiveSide(side, { activateViewport: true });
  }, []);

  if (!comparisonState.isComparisonMode) {
    return null;
  }

  return (
    <div
      id="TmtvComparisonSide"
      data-cy="TmtvComparisonSide"
      className="border-primary-light/30 bg-primary-dark/40 flex flex-shrink-0 items-center gap-1.5 rounded border px-2 py-0.5"
    >
      <span className="text-primary-light flex-shrink-0 text-xs">检查</span>
      <div className="flex min-w-0 rounded p-0.5">
        {(['baseline', 'followup'] as const).map(side => {
          const isActive = comparisonState.activeSide === side;

          return (
            <Button
              key={side}
              variant="ghost"
              className={`min-w-16 h-6 rounded px-2 text-xs font-medium leading-none ${
                isActive
                  ? 'bg-primary-active text-white'
                  : 'text-primary-light hover:bg-primary-dark hover:text-white'
              }`}
              onClick={() => handleSelectSide(side)}
              onPointerDown={event => event.stopPropagation()}
              aria-pressed={isActive}
            >
              {SIDE_LABELS[side]}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

ComparisonSideSelector.propTypes = {
  servicesManager: PropTypes.object,
};

export default ComparisonSideSelector;
