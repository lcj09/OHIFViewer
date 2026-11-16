import getWADORSImageId from './getWADORSImageId';

// 2026-11-05 WADO-URI 调图参数构建：支持图像类型(Modality)和检查日期(StudyDate)
function buildInstanceWadoUrl(config, instance) {
  const { StudyInstanceUID, SeriesInstanceUID, SOPInstanceUID } = instance;
  const params = [];

  params.push('requestType=WADO');
  params.push(`studyUID=${StudyInstanceUID}`);
  params.push(`seriesUID=${SeriesInstanceUID}`);
  params.push(`objectUID=${SOPInstanceUID}`);
  params.push('contentType=application/dicom');
  params.push('transferSyntax=*');

  // 2026-11-05 新增：图像类型、检查日期、登记号（自定义扩展，非 DICOM PS3.18 标准）
  // 服务端为自定义实现，可接收这些参数用于业务逻辑（如日志、权限、缓存）
  if (instance.Modality) {
    params.push(`modality=${encodeURIComponent(instance.Modality)}`);
  }
  if (instance.StudyDate) {
    params.push(`studyDate=${instance.StudyDate}`);
  }
  // 2026-11-09 新增：登记号（PatientID，DICOM tag 0010,0020）
  if (instance.PatientID) {
    params.push(`patientId=${encodeURIComponent(instance.PatientID)}`);
  }

  const paramString = params.join('&');

  return `${config.wadoUriRoot}?${paramString}`;
}

/**
 * Obtain an imageId for Cornerstone from an image instance
 *
 * @param instance
 * @param frame
 * @param thumbnail
 * @returns {string} The imageId to be used by Cornerstone
 */
export default function getImageId({ instance, frame, config, thumbnail = false }) {
  if (!instance) {
    return;
  }

  if (instance.imageId && frame === undefined) {
    return instance.imageId;
  }

  if (instance.url) {
    return instance.url;
  }

  const renderingAttr = thumbnail ? 'thumbnailRendering' : 'imageRendering';

  if (!config[renderingAttr] || config[renderingAttr] === 'wadouri') {
    const wadouri = buildInstanceWadoUrl(config, instance);

    let imageId = 'dicomweb:' + wadouri;
    if (frame !== undefined) {
      imageId += '&frame=' + frame;
    }

    return imageId;
  } else {
    return getWADORSImageId(instance, config, frame); // WADO-RS Retrieve Frame
  }
}
