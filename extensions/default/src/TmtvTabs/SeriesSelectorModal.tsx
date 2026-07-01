import React, { useState, useEffect } from 'react';
import { Button, Icons } from '@ohif/ui-next';

interface Series {
  seriesInstanceUid: string;
  description: string;
  modality: string;
  seriesNumber: number;
  instances: number;
}

interface SeriesSelectorModalProps {
  seriesList: Series[];
  onSelect: (ctUid: string, ptUid: string) => void;
  onClose: () => void;
}

/**
 * 序列选择弹窗
 * 用户从当前 study 的序列列表中选择 1 个 CT + 1 个 PT
 */
const SeriesSelectorModal: React.FC<SeriesSelectorModalProps> = ({
  seriesList,
  onSelect,
  onClose,
}) => {
  const [selectedCt, setSelectedCt] = useState<string | null>(null);
  const [selectedPt, setSelectedPt] = useState<string | null>(null);

  const ctSeries = seriesList.filter(s => s.modality === 'CT');
  const ptSeries = seriesList.filter(s => s.modality === 'PT');

  const canConfirm = selectedCt && selectedPt;

  const handleConfirm = () => {
    if (canConfirm) {
      onSelect(selectedCt, selectedPt);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#1a1a2e] rounded-lg shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2a4a]">
          <h3 className="text-white font-medium text-sm">选择 CT 和 PT 序列</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* CT 序列选择 */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">CT 序列</label>
            <div className="space-y-1">
              {ctSeries.map(series => (
                <div
                  key={series.seriesInstanceUid}
                  onClick={() => setSelectedCt(series.seriesInstanceUid)}
                  className={`
                    flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors
                    ${selectedCt === series.seriesInstanceUid
                      ? 'bg-blue-600/20 border border-blue-500'
                      : 'bg-[#2a2a3a] border border-transparent hover:border-gray-600'
                    }
                  `}
                >
                  <div className={`
                    w-4 h-4 rounded border-2 flex items-center justify-center
                    ${selectedCt === series.seriesInstanceUid
                      ? 'border-blue-500 bg-blue-500'
                      : 'border-gray-600'
                    }
                  `}>
                    {selectedCt === series.seriesInstanceUid && (
                      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-xs truncate">{series.description || '未命名'}</div>
                    <div className="text-gray-500 text-xs">序列 #{series.seriesNumber} · {series.instances} 张图像</div>
                  </div>
                </div>
              ))}
              {ctSeries.length === 0 && (
                <div className="text-gray-500 text-xs text-center py-4">未找到 CT 序列</div>
              )}
            </div>
          </div>

          {/* PT 序列选择 */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">PT 序列</label>
            <div className="space-y-1">
              {ptSeries.map(series => (
                <div
                  key={series.seriesInstanceUid}
                  onClick={() => setSelectedPt(series.seriesInstanceUid)}
                  className={`
                    flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors
                    ${selectedPt === series.seriesInstanceUid
                      ? 'bg-blue-600/20 border border-blue-500'
                      : 'bg-[#2a2a3a] border border-transparent hover:border-gray-600'
                    }
                  `}
                >
                  <div className={`
                    w-4 h-4 rounded border-2 flex items-center justify-center
                    ${selectedPt === series.seriesInstanceUid
                      ? 'border-blue-500 bg-blue-500'
                      : 'border-gray-600'
                    }
                  `}>
                    {selectedPt === series.seriesInstanceUid && (
                      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-xs truncate">{series.description || '未命名'}</div>
                    <div className="text-gray-500 text-xs">序列 #{series.seriesNumber} · {series.instances} 张图像</div>
                  </div>
                </div>
              ))}
              {ptSeries.length === 0 && (
                <div className="text-gray-500 text-xs text-center py-4">未找到 PT 序列</div>
              )}
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#2a2a4a]">
          <Button
            variant="ghost"
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className={!canConfirm ? 'opacity-50 cursor-not-allowed' : ''}
          >
            确认加载
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SeriesSelectorModal;
