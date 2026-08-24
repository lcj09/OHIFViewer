import React from 'react';
import classNames from 'classnames';
import PropTypes from 'prop-types';

import './ViewportOverlay.css';

/**
 * Renders text overlays (top-left, top-right, bottom-left, bottom-right)
 * around the active viewport for metadata or status messages.
 *
 * The parent is responsible for styling offsets.
 *
 * [2026-08-20 修改] 新增 fontSizeClass 可选 prop：
 *   允许按模式覆盖四角标注字体大小。默认 'text-base leading-5'（16px），
 *   不传或传 undefined 时行为与原实现完全一致，不影响其他模式。
 * [2026-08-20 新增] topOffset 可选 prop：
 *   以行内样式覆盖顶部叠加层的 top 偏移（默认 .overlay-top 为 2.15rem）。
 *   仅当传入时生效，如 TMTV 模式传 '0' 消除顶部留白。
 */
const classes = {
  topLeft: 'overlay-top left-viewport',
  topRight: 'overlay-top right-viewport-scrollbar',
  bottomRight: 'overlay-bottom right-viewport-scrollbar',
  bottomLeft: 'overlay-bottom left-viewport',
};

function ViewportOverlay({
  topLeft,
  topRight,
  bottomRight,
  bottomLeft,
  color = 'text-highlight',
  shadowClass = 'shadow-dark',
  fontSizeClass = 'text-base leading-5',
  topOffset,
}) {
  const overlay = 'absolute pointer-events-none viewport-overlay';
  const topOffsetStyle = topOffset !== undefined ? { top: topOffset } : {};

  return (
    <div className={classNames(color, 'overlay-text', shadowClass, fontSizeClass)}>
      <div
        data-cy="viewport-overlay-top-left"
        className={classNames(overlay, classes.topLeft)}
        style={topOffsetStyle}
      >
        {topLeft}
      </div>
      <div
        data-cy="viewport-overlay-top-right"
        className={classNames(overlay, classes.topRight)}
        style={{ transform: 'translateX(9px)', ...topOffsetStyle }}
      >
        {topRight}
      </div>
      <div
        data-cy="viewport-overlay-bottom-right"
        className={classNames(overlay, classes.bottomRight)}
        style={{ transform: 'translateX(6px)' }}
      >
        {bottomRight}
      </div>
      <div
        data-cy="viewport-overlay-bottom-left"
        className={classNames(overlay, classes.bottomLeft)}
      >
        {bottomLeft}
      </div>
    </div>
  );
}

ViewportOverlay.propTypes = {
  topLeft: PropTypes.node,
  topRight: PropTypes.node,
  bottomRight: PropTypes.node,
  bottomLeft: PropTypes.node,
  color: PropTypes.string,
  shadowClass: PropTypes.string,
  fontSizeClass: PropTypes.string,
  topOffset: PropTypes.string,
};

export { ViewportOverlay };
