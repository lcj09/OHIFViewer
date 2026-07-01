import React, { useState } from 'react';
import { useTmtvTabs, TmtvTab } from './TmtvTabContext';
import { Icons } from '@ohif/ui-next';

interface TabBarProps {
  onAddTab: () => void;
}

/**
 * TMTV 多 Tab 栏组件
 * 显示所有已打开的序列对 Tab，支持切换、关闭、新增
 */
const TabBar: React.FC<TabBarProps> = ({ onAddTab }) => {
  const { tabs, activeTabId, switchTab, removeTab } = useTmtvTabs();

  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center bg-[#1a1a2e] border-b border-[#2a2a4a] h-[36px] px-2 gap-1 select-none">
      {tabs.map(tab => (
        <TabItem
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onSwitch={() => switchTab(tab.id)}
          onClose={() => removeTab(tab.id)}
          canClose={tabs.length > 1}
        />
      ))}
      {/* 新增 Tab 按钮 */}
      <button
        onClick={onAddTab}
        className="flex items-center gap-1 px-3 h-[28px] rounded text-xs text-gray-400 hover:text-white hover:bg-[#2a2a4a] transition-colors ml-1"
        title="添加新的序列对"
      >
        <Icons.Plus className="w-3.5 h-3.5" />
        <span>添加序列</span>
      </button>
    </div>
  );
};

interface TabItemProps {
  tab: TmtvTab;
  isActive: boolean;
  onSwitch: () => void;
  onClose: () => void;
  canClose: boolean;
}

const TabItem: React.FC<TabItemProps> = ({ tab, isActive, onSwitch, onClose, canClose }) => {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSwitch}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`
        flex items-center gap-2 px-3 h-[28px] rounded text-xs cursor-pointer transition-colors max-w-[220px]
        ${isActive
          ? 'bg-[#2a2a4a] text-white'
          : 'text-gray-400 hover:text-white hover:bg-[#2a2a3a]'
        }
      `}
      title={`${tab.ctDescription} + ${tab.ptDescription}`}
    >
      {/* Tab 图标 */}
      <Icons.GroupLayers className="w-3.5 h-3.5 flex-shrink-0 text-blue-400" />

      {/* Tab 文字 */}
      <span className="truncate flex-1">
        {tab.patientName || '患者'} - {tab.ctDescription?.replace(/CT\s*/i, '').substring(0, 12) || 'CT'}
      </span>

      {/* 关闭按钮 */}
      {canClose && (hovered || isActive) && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-[#4a4a6a] transition-colors"
          title="关闭此 Tab"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
};

export default TabBar;
