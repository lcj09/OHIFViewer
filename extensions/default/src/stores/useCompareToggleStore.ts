import { create } from 'zustand';

/**
 * 2026-10-12 功能说明：TMTV对比布局分侧折叠状态管理
 *
 * 用于跟踪2x4对比布局中左右两侧的折叠状态：
 * - savedGridState: 首次折叠时保存的完整2x4网格状态
 * - leftCollapsed / rightCollapsed: 左右两侧是否折叠为1x1
 * - leftOneUpViewportId / rightOneUpViewportId: 折叠后显示的视口ID
 */
type CompareToggleState = {
  savedGridState: any | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftOneUpViewportId: string | null;
  rightOneUpViewportId: string | null;
  setSavedGridState: (state: any) => void;
  setCollapsed: (left: boolean, right: boolean) => void;
  setOneUpViewportIds: (left: string | null, right: string | null) => void;
  reset: () => void;
};

export const useCompareToggleStore = create<CompareToggleState>(set => ({
  savedGridState: null,
  leftCollapsed: false,
  rightCollapsed: false,
  leftOneUpViewportId: null,
  rightOneUpViewportId: null,
  setSavedGridState: state => set({ savedGridState: state }),
  setCollapsed: (left, right) => set({ leftCollapsed: left, rightCollapsed: right }),
  setOneUpViewportIds: (left, right) =>
    set({ leftOneUpViewportId: left, rightOneUpViewportId: right }),
  reset: () =>
    set({
      savedGridState: null,
      leftCollapsed: false,
      rightCollapsed: false,
      leftOneUpViewportId: null,
      rightOneUpViewportId: null,
    }),
}));
