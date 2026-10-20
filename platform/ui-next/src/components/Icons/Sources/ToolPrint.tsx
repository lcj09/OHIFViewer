import React from 'react';

// 2026-10-19 功能说明：TMTV 工具栏打印按钮图标（打印机图形），用于截图保存当前视口布局
// 2026-10-20 修改：viewBox 裁剪到 path 紧凑包围盒，让图标在按钮中显示更大
const ToolPrint: React.FC<React.SVGProps<SVGSVGElement>> = props => (
  <svg
    width="24"
    height="24"
    viewBox="96 64 832 832"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      d="M928 288H96v384h160v224h512V672h160zM704 832H320V544h384z m160-224h-96v-128H256v128h-96V352h704zM320 192h384v64h64V128H256v128h64v-64z"
      fill="currentColor"
    />
    <path
      d="M384 608h256v64H384zM384 704h256v64H384z"
      fill="currentColor"
    />
    <path
      d="M800 416m-32 0a32 32 0 1 0 64 0 32 32 0 1 0-64 0Z"
      fill="currentColor"
    />
  </svg>
);

export default ToolPrint;
