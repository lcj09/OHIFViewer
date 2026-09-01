import React, { useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import html2canvas from 'html2canvas';
import { classes } from '@ohif/core';
import comparisonService from '../services/TMTVComparisonService';
import { getViewportStudyUID } from '../utils/comparisonMeasurements';
import {
  getEnabledElement as csGetEnabledElement,
  utilities as csUtils,
} from '@cornerstonejs/core';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Icons,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@ohif/ui-next';

function SaveMenu({ commandsManager, servicesManager, ...props }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // 获取所需服务
  const {
    viewportGridService,
    uiNotificationService,
    hangingProtocolService,
    displaySetService,
    customizationService,
  } = servicesManager.services;

  /**
   * 2026-08-31 功能说明：对比模式按视口当前加载数据获取元数据，避免换序列后沿用旧检查信息。
   * 返回包含patientID、patientName、studyDate等上传所需字段的元数据对象
   */
  const getActiveViewportMetadata = useCallback(() => {
    try {
      // 获取当前选中的视口ID
      const { activeViewportId } = viewportGridService.getState();
      if (!activeViewportId) return null;

      let firstDisplaySet;
      const isComparison = comparisonService.isComparisonProtocolActive(servicesManager);
      const studyUID = isComparison && getViewportStudyUID(servicesManager, activeViewportId);
      if (isComparison) {
        if (!studyUID) return null;
        firstDisplaySet = servicesManager.services.cornerstoneViewportService
          .getViewportDisplaySets(activeViewportId)[0];
      } else {
        const { viewportMatchDetails } = hangingProtocolService.getMatchDetails();
        const displaySetsInfo = viewportMatchDetails?.get(activeViewportId)?.displaySetsInfo;
        if (!displaySetsInfo?.length) return null;
        firstDisplaySet = displaySetService.getDisplaySetByUID(
          displaySetsInfo[0].displaySetInstanceUID
        );
      }
      if (!firstDisplaySet) return null;

      // 确保DisplaySet中有图像数据
      if (!firstDisplaySet.images || firstDisplaySet.images.length === 0) return null;

      // 获取第一张图像的imageId用于查询元数据
      const imageId = firstDisplaySet.images[0].imageId || firstDisplaySet.images[0].id;
      if (!imageId) return null;

      // 通过MetadataProvider获取DICOM实例元数据
      const MetadataProvider = classes.MetadataProvider;
      const instance = MetadataProvider.get('instance', imageId);
      if (!instance) return null;
      if (isComparison && instance.StudyInstanceUID !== studyUID) return null;

      // 性别映射：DICOM编码(M/F/O) -> 中文显示
      const sexMap = { M: '男', F: '女', O: '其他' };

      // 构造并返回上传所需的元数据对象
      return {
        patientID: instance.PatientID || '',
        patientName: instance.PatientName?.Alphabetic || instance.PatientName || '',
        patientSex: sexMap[instance.PatientSex] || instance.PatientSex || '',
        patientBirthDate: instance.PatientBirthDate || '',
        accessionNumber: instance.AccessionNumber || '',
        studyDate: instance.StudyDate || '',
        studyTime: instance.StudyTime || '',
        seriesDescription: instance.SeriesDescription || '',
        seriesNumber: String(instance.SeriesNumber || '1'),
        modality: firstDisplaySet.Modality || instance.Modality || '',
        instanceNumber: '1',
        fileName: `${instance.PatientID || 'unknown'}_${instance.StudyDate || ''}_${firstDisplaySet.Modality || ''}_1.jpg`,
        displaySet: firstDisplaySet,
      };
    } catch (e) {
      console.error('SaveMenu: 获取视口元数据失败', e);
      return null;
    }
  }, [viewportGridService, hangingProtocolService, displaySetService, servicesManager]);

  /**
   * 上传单张图像
   * @param wrapperElement - 视口容器DOM元素（用于html2canvas截图）
   * @param metadata - DICOM元数据对象
   * @param sliceIndex - 当前切片索引（从0开始）
   */
  const uploadSingleImage = async (
    wrapperElement: HTMLElement,
    metadata: ReturnType<typeof getActiveViewportMetadata>,
    sliceIndex: number
  ) => {
    // 使用html2canvas截取视口DOM（包含Canvas图像 + SVG标注 + React覆盖层）
    const canvas = await html2canvas(wrapperElement as HTMLElement, {
      useCORS: true,
      backgroundColor: '#000000',
      scale: 1,
    });

    // 将Canvas转为JPG格式的Base64字符串
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const jpgBase64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    // 从customizationService读取可配置的上传地址
    const uploadConfig = customizationService.getCustomization('tmtv.imageUpload') as {
      apiUrl?: string;
    };
    const apiUrl = uploadConfig?.apiUrl || 'http://localhost:8028/api/fileUpload';

    // 构造POST请求体：13个字段 + jpgBase64图像数据
    const payload = {
      patientID: metadata.patientID,
      patientName: metadata.patientName,
      patientSex: metadata.patientSex,
      patientBirthDate: metadata.patientBirthDate,
      accessionNumber: metadata.accessionNumber,
      studyDate: metadata.studyDate,
      studyTime: metadata.studyTime,
      seriesDescription: metadata.seriesDescription,
      seriesNumber: metadata.seriesNumber,
      modality: metadata.modality,
      // 实例号根据切片索引动态生成
      instanceNumber: String(sliceIndex + 1),
      // 文件名格式：{患者ID}_{检查日期}_{模态}_{切片号}.jpg
      fileName: `${metadata.patientID}_${metadata.studyDate}_${metadata.modality}_${sliceIndex + 1}.jpg`,
      jpgBase64,
    };

    // 发送POST请求到上传接口
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // 检查响应状态码
    if (!response.ok) {
      const errorText = await response.text().catch(() => '未知错误');
      throw new Error(`第${sliceIndex + 1}张上传失败 (${response.status}): ${errorText}`);
    }

    return response.json().catch(() => ({}));
  };

  /** 处理"图像"按钮点击：上传当前选中视口的单张图像 */
  const handleSaveImage = async () => {
    setIsMenuOpen(false);

    try {
      setIsUploading(true);

      // 步骤1：获取活动视口ID
      const { activeViewportId } = viewportGridService.getState();
      if (!activeViewportId) throw new Error('未选中任何图像框');

      // 步骤2：通过data属性找到视口DOM元素
      const viewportElement = document.querySelector(`[data-viewportid="${activeViewportId}"]`);
      if (!viewportElement) throw new Error('未找到选中的图像框元素');

      // 步骤3：找到包含Canvas和覆盖层的wrapper容器
      const wrapperElement = viewportElement.closest('.viewport-wrapper');
      if (!wrapperElement) throw new Error('未找到图像框容器');

      // 步骤4：获取DICOM元数据（用于构造请求参数）
      const metadata = getActiveViewportMetadata();
      if (!metadata) throw new Error('无法获取当前图像的DICOM元数据');

      // 步骤5：截图并上传（sliceIndex=0表示当前视图）
      await uploadSingleImage(wrapperElement as HTMLElement, metadata, 0);

      uiNotificationService.show({
        title: '上传成功',
        message: '图像已成功上传',
        type: 'success',
      });
    } catch (error) {
      console.error('SaveMenu: 图像上传失败', error);
      uiNotificationService.show({
        title: '上传失败',
        message: error instanceof Error ? error.message : '图像上传过程中发生错误',
        type: 'error',
      });
    } finally {
      setIsUploading(false);
    }
  };

  /** 处理"序列"按钮点击：遍历当前视口的所有切片并逐张上传 */
  const handleSaveSeries = async () => {
    setIsMenuOpen(false);

    try {
      setIsUploading(true);

      // 步骤1：获取活动视口ID和DOM元素
      const { activeViewportId } = viewportGridService.getState();
      if (!activeViewportId) throw new Error('未选中任何图像框');

      const viewportElement = document.querySelector(`[data-viewportid="${activeViewportId}"]`);
      if (!viewportElement) throw new Error('未找到选中的图像框元素');

      const wrapperElement = viewportElement.closest('.viewport-wrapper');
      if (!wrapperElement) throw new Error('未找到图像框容器');

      // 步骤2：获取Cornerstone3D的enabledElement和viewport实例
      const enabledElement = csGetEnabledElement(viewportElement as HTMLElement);
      if (!enabledElement) throw new Error('无法获取Cornerstone视口');
      const { viewport } = enabledElement;

      // 步骤3：获取总切片数（Volume视口专用API）
      let numberOfSlices: number;
      try {
        numberOfSlices = viewport.getNumberOfSlices();
      } catch (e) {
        throw new Error('无法获取切片数量，当前视口可能不支持序列上传');
      }

      if (numberOfSlices <= 0 || !Number.isFinite(numberOfSlices)) {
        throw new Error('当前视口没有可用的切片数据');
      }

      // 步骤4：获取DICOM元数据
      const metadata = getActiveViewportMetadata();
      if (!metadata) throw new Error('无法获取当前图像的DICOM元数据');

      // 步骤5：循环遍历每一张切片，逐张截图上传
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < numberOfSlices; i++) {
        try {
          // 切换到第i张切片
          csUtils.jumpToSlice(viewportElement as HTMLElement, { imageIndex: i });
          // 强制重新渲染以确保截图内容正确
          viewport.render();

          // 等待渲染完成（给浏览器时间处理）
          await new Promise(resolve => setTimeout(resolve, 100));

          // 截图并上传第i张
          await uploadSingleImage(wrapperElement as HTMLElement, metadata, i);
          successCount++;
        } catch (e) {
          // 单张失败不中断整体流程，继续处理下一张
          console.warn(`SaveMenu: 第${i + 1}张上传失败`, e);
          failCount++;
        }
      }

      // 步骤6：汇总结果并显示提示
      if (failCount === 0) {
        uiNotificationService.show({
          title: '序列上传完成',
          message: `共 ${successCount} 张图像全部上传成功`,
          type: 'success',
        });
      } else if (successCount > 0) {
        uiNotificationService.show({
          title: '部分上传完成',
          message: `成功 ${successCount} 张，失败 ${failCount} 张`,
          type: 'warning',
        });
      } else {
        throw new Error(`全部 ${failCount} 张图像上传均失败`);
      }
    } catch (error) {
      console.error('SaveMenu: 序列上传失败', error);
      uiNotificationService.show({
        title: '序列上传失败',
        message: error instanceof Error ? error.message : '序列上传过程中发生错误',
        type: 'error',
      });
    } finally {
      setIsUploading(false);
    }
  };

  // SaveMenu 容器：gap-[12px] 控制撤销/重做/保存按钮组间距，按钮与文字作为整体
  return (
    <div
      id="SaveMenu"
      data-cy="SaveMenu"
      className="flex items-center gap-[12px]"
    >
      {/* ========== 撤销/重做功能按钮（2026-06-16 添加）========== */}
      {/* 撤销按钮：回退上一步标注操作 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg"
              aria-label="撤销"
              onClick={() => commandsManager.run('undo')}
            >
              <Icons.Undo className="h-6 w-6" />
            </Button>
            <span className="whitespace-nowrap text-[12px] leading-tight text-white">撤销</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div>撤销 (Ctrl+Z)</div>
        </TooltipContent>
      </Tooltip>

      {/* 重做按钮：恢复被撤销的标注操作 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
            <Button
              variant="ghost"
              size="icon"
              className="text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg"
              aria-label="重做"
              onClick={() => commandsManager.run('redo')}
            >
              <Icons.Redo className="h-6 w-6" />
            </Button>
            <span className="whitespace-nowrap text-[12px] leading-tight text-white">重做</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div>重做 (Ctrl+Y)</div>
        </TooltipContent>
      </Tooltip>

      {/* 原有保存菜单按钮 */}
      <Popover
        open={isMenuOpen}
        onOpenChange={setIsMenuOpen}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="flex h-[56px] flex-col items-center justify-between gap-0 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={`text-foreground/80 hover:bg-background hover:text-highlight inline-flex h-10 w-10 items-center justify-center rounded-lg ${
                    isUploading ? 'bg-primary/20 text-highlight animate-pulse' : ''
                  }`}
                  aria-label="保存"
                  disabled={isUploading}
                >
                  <Icons.ByName
                    name="tool-save"
                    className="h-7 w-7"
                  />
                </Button>
                <span className="whitespace-nowrap text-[12px] leading-tight text-white">保存</span>
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div>{isUploading ? '正在上传...' : '保存'}</div>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-48 rounded-lg border-none p-1 shadow-lg"
          align="center"
          sideOffset={8}
        >
          <div className="flex flex-col gap-0.5">
            {/* 图像：上传当前选中视口的单张图像 */}
            <Button
              variant="ghost"
              className="text-common-bright hover:bg-primary-dark flex h-8 w-full items-center justify-start px-2 py-1 text-sm disabled:opacity-50"
              onClick={handleSaveImage}
              disabled={isUploading}
            >
              {isUploading ? '上传中...' : '图像'}
            </Button>
            {/* 序列：遍历当前视口的所有切片并逐张上传 */}
            <Button
              variant="ghost"
              className="text-common-bright hover:bg-primary-dark flex h-8 w-full items-center justify-start px-2 py-1 text-sm disabled:opacity-50"
              onClick={handleSaveSeries}
              disabled={isUploading}
            >
              序列
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

SaveMenu.propTypes = {
  commandsManager: PropTypes.object,
  servicesManager: PropTypes.object,
};

export default SaveMenu;
