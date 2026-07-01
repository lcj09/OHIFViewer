import { utils } from '@ohif/core';

const { downloadCsv } = utils;

export default function createAndDownloadTMTVReport(segReport, additionalReportRows, options = {}) {
  const firstReport = segReport[Object.keys(segReport)[0]];
  const columns = Object.keys(firstReport);
  const columnTranslationMap = {
    id: '分割ID',
    label: '标签',
    patientid: '患者ID',
    patientname: '患者姓名',
    studyinstanceuid: '检查UID',
    seriesinstanceuid: '序列UID',
    studydate: '检查日期',
    modifiedtime: '修改时间',
    algorithmtype: '算法类型',
    algorithmname: '算法名称',
    category: '类别',
    type: '类型',
    center_image: '中心点(图像)',
    center_world: '中心点(世界)',
    center: '中心点',
    lesionglycolysis: '病灶糖酵解量',
    suvmean: 'SUV均值',
    suvmax: 'SUV最大值',
    suvmin: 'SUV最小值',
    suvstd: 'SUV标准差',
    volume: '体积',
    numvoxels: '体素数',
    min: '最小值',
    max: '最大值',
    mean: '均值',
    stddev: '标准差',
    median: '中位数',
    skewness: '偏度',
    kurtosis: '峰度',
    count: '计数',
    maxlps: '最大LPS',
    minlps: '最小LPS',
    peakvalue: '峰值',
    peakposition: '峰值位置',
  };

  const csv = [
    columns
      .map(column => {
        const cleanColumn = column.toLowerCase().startsWith('namedstats_')
          ? column.substring(11)
          : column;
        return columnTranslationMap[cleanColumn.toLowerCase()] || cleanColumn;
      })
      .join(','),
  ];

  Object.values(segReport).forEach(segmentation => {
    const row = [];
    columns.forEach(column => {
      // if it is array then we need to replace , with space to avoid csv parsing error
      row.push(
        segmentation[column] && typeof segmentation[column] === 'object'
          ? Array.isArray(segmentation[column])
            ? segmentation[column].join(' ')
            : segmentation[column].value && Array.isArray(segmentation[column].value)
              ? segmentation[column].value.join(' ')
              : (segmentation[column].value ?? segmentation[column])
          : segmentation[column]
      );
    });
    csv.push(row.join(','));
  });

  csv.push('');
  csv.push('');
  csv.push('');

  csv.push(`患者ID,${firstReport.PatientID}`);
  csv.push(`检查日期,${firstReport.StudyDate}`);
  csv.push('');
  additionalReportRows.forEach(({ key, value: values }) => {
    const temp = [];
    const keyMap = {
      'Total Metabolic Tumor Volume': '总代谢肿瘤体积',
      'Total Lesion Glycolysis': '总病灶糖酵解量',
      'Threshold Configuration': '阈值配置',
    };
    const translatedKey = keyMap[key] || key;
    temp.push(`${translatedKey}`);
    Object.keys(values).forEach(k => {
      const kMap = { tmtv: 'TMTV', tlg: 'TLG' };
      temp.push(`${kMap[k] || k}`);
      temp.push(`${values[k]}`);
    });

    csv.push(temp.join(','));
  });

  downloadCsv(csv.join('\n'), {
    filename: options.filename ?? `${firstReport.PatientID}_tmtv.csv`,
  });
}
