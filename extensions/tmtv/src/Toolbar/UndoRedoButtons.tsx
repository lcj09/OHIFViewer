import React from 'react';
import PropTypes from 'prop-types';
import { Button, Icons, Tooltip, TooltipTrigger, TooltipContent } from '@ohif/ui-next';

/**
 * 撤销/重做工具栏按钮组件
 * 放置在TMTV模式工具栏中，与保存、布局选择等按钮并列
 */
function UndoRedoButtons({ commandsManager, servicesManager, ...props }) {
  return (
    <div
      id="UndoRedoButtons"
      data-cy="UndoRedoButtons"
      className="flex items-center gap-0"
    >
      {/* 撤销按钮 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg"
            aria-label="撤销"
            onClick={() => {
              commandsManager.run('undo');
            }}
          >
            <Icons.Undo className="h-7 w-7" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">撤销 (Ctrl+Z)</TooltipContent>
      </Tooltip>

      {/* 重做按钮 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg"
            aria-label="重做"
            onClick={() => {
              commandsManager.run('redo');
            }}
          >
            <Icons.Redo className="h-7 w-7" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">重做 (Ctrl+Y)</TooltipContent>
      </Tooltip>
    </div>
  );
}

UndoRedoButtons.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
};

export default UndoRedoButtons;
