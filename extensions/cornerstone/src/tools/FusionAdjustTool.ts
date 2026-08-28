// [2026-05-22 新增] 融合图像微调工具
//
// 功能：在融合视口中：
//   - 左键拖拽平移PET图像，不影响CT图像
//   - 右键拖拽旋转PET图像（绕视图平面法线方向旋转）
//   - 右键双击：退出微调模式（停用工具）
//   同时同步变换到同方向的PT独立视口
//   不同步MIP视口和其他截面的PET图像
//
// 实现原理：
//   使用vtkVolume actor的UserMatrix统一管理平移和旋转变换
//   变换顺序：M = Translation * Rotation（先旋转再平移）
//   旋转轴为相机视图平面法线方向，实现面内旋转效果
//
// 视口ID对应关系：
//   fusionAXIAL    → ptAXIAL
//   fusionSAGITTAL → ptSAGITTAL
//   fusionCoronal  → ptCORONAL
//   MIP视口不参与同步
//
// 鼠标按键检测：
//   通过document级mousedown事件监听器追踪当前按下的鼠标按键
//   button=0(左键)→平移, button=2(右键)→旋转

import { BaseTool } from '@cornerstonejs/tools';
import { getEnabledElement, getRenderingEngines } from '@cornerstonejs/core';
import { mat4 } from 'gl-matrix';

// [2026-08-21 新增] 右键双击退出微调模式的自定义事件名
export const FUSION_ADJUST_DEACTIVATE_EVENT = 'fusionadjust:deactivate';

// 右键双击间隔阈值（毫秒）
const RIGHT_DOUBLE_CLICK_INTERVAL = 400;

class FusionAdjustTool extends BaseTool {
  static toolName = 'FusionAdjust';

  // 每个视口的累计变换矩阵（4x4，包含平移+旋转）
  // key: viewportId, value: number[16]
  private _transforms: Map<string, number[]> = new Map();

  // 当前拖拽的鼠标按键：0=左键(平移), 2=右键(旋转)
  private _activeButton: number = 0;
  private _onMouseDown: ((e: MouseEvent) => void) | null = null;
  private _onMouseUp: (() => void) | null = null;

  // [2026-08-21 新增] 右键双击检测：记录上次右键点击时间
  private _lastRightClickTime: number = 0;

  constructor(toolProps = {}, defaultToolProps = {
    supportedInteractionTypes: ['Mouse'],
    configuration: {
      rotationSensitivity: 0.3,
    },
  }) {
    super(toolProps, defaultToolProps);

    if (typeof document !== 'undefined') {
      this._onMouseDown = (e: MouseEvent) => {
        this._activeButton = e.button;

        // [2026-08-21 新增] 右键双击检测：两次右键点击间隔 <= 阈值则判定为双击
        // 派发 FUSION_ADJUST_DEACTIVATE_EVENT 通知 FusionAdjustMenu 停用工具
        if (e.button === 2) {
          const now = Date.now();
          if (now - this._lastRightClickTime <= RIGHT_DOUBLE_CLICK_INTERVAL) {
            this._lastRightClickTime = 0; // 重置，避免三击再触发
            try {
              document.dispatchEvent(new CustomEvent(FUSION_ADJUST_DEACTIVATE_EVENT));
            } catch (e) {
              // ignore
            }
          } else {
            this._lastRightClickTime = now;
          }
        } else {
          // 非右键点击重置计时，确保只有连续两次右键才算双击
          this._lastRightClickTime = 0;
        }
      };
      this._onMouseUp = () => {
        this._activeButton = 0;
      };
      document.addEventListener('mousedown', this._onMouseDown, true);
      document.addEventListener('mouseup', this._onMouseUp, true);
    }
  }

  mouseDragCallback(evt: any) {
    const { element, deltaPoints } = evt.detail;
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    if (this._activeButton === 2) {
      this._handleRotate(viewport, deltaPoints.canvas);
    } else {
      this._handlePan(viewport, deltaPoints.world);
    }
  }

  // ========== 左键平移 ==========

  private _handlePan(viewport: any, deltaPointsWorld: number[]) {
    if (deltaPointsWorld[0] === 0 && deltaPointsWorld[1] === 0 && deltaPointsWorld[2] === 0) return;

    const actors = viewport.getActors();
    if (actors.length < 2) return;

    const ptActor = actors[1].actor as any;
    if (!this._isActorReady(ptActor)) return;

    const viewportId = viewport.id;
    const transform = this._getTransform(viewportId);

    const deltaMat = mat4.create() as Float32Array;
    mat4.translate(deltaMat, deltaMat, deltaPointsWorld as [number, number, number]);

    const newTransform = mat4.create() as Float32Array;
    mat4.multiply(newTransform, deltaMat, transform);

    if (!this._isValidMatrix(newTransform)) return;

    this._setTransform(viewportId, newTransform);
    this._applyTransformToActor(ptActor, newTransform);
    this._safeRender(viewport);

    this._syncToCorrespondingPTViewport(viewportId, newTransform);
  }

  // ========== 右键旋转 ==========

  private _handleRotate(viewport: any, deltaPointsCanvas: number[]) {
    const actors = viewport.getActors();
    if (actors.length < 2) return;

    // [2026-08-21 修复] 旋转角度计算
    // 原实现 angleDegrees = deltaPointsCanvas[0] * 0.3，仅用水平分量且灵敏度极低
    // （每像素仅旋转 0.3° × π/180 ≈ 0.005 rad），导致只能缓慢单方向旋转
    // 修复：增大灵敏度到 1.0 度/像素，取反使旋转方向与鼠标移动方向一致
    // 向右拖 → dx > 0 → 取负 → 逆时针（图像向右转），向左拖 → dx < 0 → 取正 → 顺时针
    const sensitivity = (this.configuration as any).rotationSensitivity || 1.0;
    const angleDegrees = -deltaPointsCanvas[0] * sensitivity;
    const angleRadians = angleDegrees * (Math.PI / 180);

    if (Math.abs(angleRadians) < 0.0001) return;

    const ptActor = actors[1].actor as any;
    if (!this._isActorReady(ptActor)) return;

    const viewportId = viewport.id;
    const transform = this._getTransform(viewportId);

    const camera = viewport.getCamera();
    const viewPlaneNormal = camera.viewPlaneNormal as [number, number, number];
    if (!viewPlaneNormal || viewPlaneNormal.some((v: number) => v === undefined || isNaN(v))) return;

    const rotMat = mat4.create() as Float32Array;
    mat4.rotate(rotMat, rotMat, angleRadians, viewPlaneNormal);

    const newTransform = mat4.create() as Float32Array;
    mat4.multiply(newTransform, rotMat, transform);

    if (!this._isValidMatrix(newTransform)) return;

    this._setTransform(viewportId, newTransform);
    this._applyTransformToActor(ptActor, newTransform);
    this._safeRender(viewport);

    this._syncToCorrespondingPTViewport(viewportId, newTransform);
  }

  // ========== 安全检查方法 ==========

  // 检查actor是否已就绪（mapper存在且图像数据已加载）
  private _isActorReady(actor: any): boolean {
    if (!actor) return false;
    try {
      const mapper = actor.getMapper?.();
      if (!mapper) return false;
      const inputData = mapper.getInputData?.();
      if (!inputData) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  // 检查变换矩阵是否有效（无NaN/Infinity）
  private _isValidMatrix(mat: Float32Array): boolean {
    for (let i = 0; i < 16; i++) {
      const v = mat[i];
      if (!Number.isFinite(v)) return false;
    }
    return true;
  }

  // 安全渲染：捕获渲染管线异常，防止崩溃
  private _safeRender(viewport: any) {
    try {
      if (viewport && typeof viewport.render === 'function') {
        viewport.render();
      }
    } catch (e) {
      console.warn('FusionAdjustTool: 渲染失败，可能图像尚未完全加载', e);
    }
  }

  // ========== 变换矩阵管理 ==========

  private _getTransform(viewportId: string): Float32Array {
    const stored = this._transforms.get(viewportId);
    if (stored) {
      return new Float32Array(stored);
    }
    return new Float32Array(mat4.create() as Float32Array);
  }

  private _setTransform(viewportId: string, transform: Float32Array) {
    this._transforms.set(viewportId, Array.from(transform));
  }

  // 将变换矩阵应用到PET actor的UserMatrix
  private _applyTransformToActor(actor: any, transform: Float32Array) {
    try {
      actor.setPosition(0, 0, 0);
      actor.setUserMatrix(new Float64Array(transform));
      actor.modified();
    } catch (e) {
      console.warn('FusionApplyTransformToActor: 应用变换失败', e);
    }
  }

  // ========== PT视口同步 ==========

  private _syncToCorrespondingPTViewport(fusionViewportId: string, transform: Float32Array) {
    const ptViewportId = this._getCorrespondingPTViewportId(fusionViewportId);
    if (!ptViewportId) return;

    try {
      const ptViewport = this._getViewportById(ptViewportId);
      if (!ptViewport) return;

      const ptActor = ptViewport.getActors()[0]?.actor as any;
      if (!ptActor || !this._isActorReady(ptActor)) return;

      this._applyTransformToActor(ptActor, transform);
      this._transforms.set(ptViewportId, Array.from(transform));
      this._safeRender(ptViewport);
    } catch (e) {
      // 同步失败不影响融合视口的操作
    }
  }

  private _getCorrespondingPTViewportId(fusionViewportId: string): string | null {
    const lower = fusionViewportId.toLowerCase();
    if (lower.startsWith('fusion')) {
      const orientation = fusionViewportId.slice(6);
      return 'pt' + orientation.toUpperCase();
    }
    return null;
  }

  private _getViewportById(viewportId: string): any | null {
    try {
      const renderingEngines = getRenderingEngines();
      const renderingEngine = renderingEngines?.[0];
      if (!renderingEngine) return null;
      return renderingEngine.getViewport(viewportId);
    } catch (e) {
      return null;
    }
  }

  // ========== 重置功能 ==========

  resetOffset(viewport: any) {
    const viewportId = viewport.id;
    if (!this._transforms.has(viewportId)) return;

    const actors = viewport.getActors();
    if (actors.length < 2) return;

    const identity = new Float32Array(mat4.create() as Float32Array);
    this._applyTransformToActor(actors[1].actor, identity);
    this._transforms.delete(viewportId);
    this._safeRender(viewport);

    this._resetCorrespondingPTViewport(viewportId);
  }

  private _resetCorrespondingPTViewport(fusionViewportId: string) {
    const ptViewportId = this._getCorrespondingPTViewportId(fusionViewportId);
    if (!ptViewportId || !this._transforms.has(ptViewportId)) return;

    try {
      const ptViewport = this._getViewportById(ptViewportId);
      if (!ptViewport) return;

      const ptActor = ptViewport.getActors()[0]?.actor as any;
      if (!ptActor) return;

      const identity = new Float32Array(mat4.create() as Float32Array);
      this._applyTransformToActor(ptActor, identity);
      this._transforms.delete(ptViewportId);
      this._safeRender(ptViewport);
    } catch (e) {
      // 同步重置失败不影响融合视口
    }
  }

  getOffset(viewportId: string): number[] | undefined {
    return this._transforms.get(viewportId);
  }

  resetAllOffsets(getViewportFn: (viewportId: string) => any) {
    const identity = new Float32Array(mat4.create() as Float32Array);
    this._transforms.forEach((_, viewportId) => {
      const viewport = getViewportFn(viewportId);
      if (!viewport) return;

      const actors = viewport.getActors();
      const ptActorEntry = actors.length >= 2 ? actors[1] : actors[0];
      if (ptActorEntry) {
        this._applyTransformToActor(ptActorEntry.actor, identity);
        this._safeRender(viewport);
      }
    });
    this._transforms.clear();
  }

  /**
   * Clean up document-level event listeners to prevent memory leaks.
   * Called during toolGroup cleanup via tool.cleanUpData().
   */
  cleanUpData() {
    if (typeof document !== 'undefined') {
      if (this._onMouseDown) {
        document.removeEventListener('mousedown', this._onMouseDown, true);
        this._onMouseDown = null;
      }
      if (this._onMouseUp) {
        document.removeEventListener('mouseup', this._onMouseUp, true);
        this._onMouseUp = null;
      }
    }
    this._transforms.clear();
    this._activeButton = 0;
    this._lastRightClickTime = 0;
  }
}

export default FusionAdjustTool;
