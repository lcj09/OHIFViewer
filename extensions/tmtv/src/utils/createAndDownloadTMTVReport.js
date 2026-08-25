import { utils } from '@ohif/core';

const { downloadCsv } = utils;

export default function createAndDownloadTMTVReport(segReport, reportSections = [], options = {}) {
  // [2026-08-25 功能] 第四阶段导出临床友好的结构化 TMTV 报告，隐藏底层 OHIF 原始 segmentation stats
  const firstReport = segReport[Object.keys(segReport)[0]];
  const csv = [];

  reportSections.forEach(section => {
    appendReportSection(csv, section);
  });

  downloadCsv(csv.join('\n'), {
    filename: options.filename ?? `${firstReport.PatientID}_tmtv.csv`,
  });
}

function appendReportSection(csv, section) {
  if (!section) {
    return;
  }

  if (section.type === 'section') {
    csv.push(csvRow([translateReportLabel(section.title)]));
    csv.push('');
    return;
  }

  if (section.type === 'rows') {
    if (section.title) {
      csv.push(csvRow([translateReportLabel(section.title)]));
    }

    section.rows.forEach(([key, value]) => {
      csv.push(csvRow([translateReportLabel(key), value]));
    });

    csv.push('');
    return;
  }

  if (section.type === 'table') {
    csv.push(csvRow([translateReportLabel(section.title)]));
    csv.push(csvRow(section.columns.map(translateReportLabel)));
    section.rows.forEach(row => {
      csv.push(csvRow(row));
    });
    csv.push('');
  }
}

function translateReportLabel(label) {
  const labelMap = {
    'TMTV Report': 'TMTV报告',
    'Generated Time': '生成时间',
    'Patient ID': '患者ID',
    'Patient Name': '患者姓名',
    'Study Date': '检查日期',
    'Study Instance UID': '检查UID',
    'Series Instance UID': '序列UID',
    'Patient-level Quantification': '患者级定量',
    'Total TMTV (mL)': 'Total TMTV (mL)',
    'Total TLG': 'Total TLG',
    'Lesion Count': '病灶数量',
    'Confirmed Lesion Count': '已确认病灶数量',
    'Candidate Lesion Count': '候选病灶数量',
    'Rejected Lesion Count': '已拒绝病灶数量',
    'Lesion List': '病灶列表',
    Lesion: '病灶',
    Status: '状态',
    'Volume (mL)': '体积 (mL)',
    SUVmin: 'SUVmin',
    SUVmax: 'SUVmax',
    SUVmean: 'SUVmean',
    TLG: 'TLG',
    'Center X (World)': '中心点X World',
    'Center Y (World)': '中心点Y World',
    'Center Z (World)': '中心点Z World',
    'Bounds IJK': '包围盒 IJK',
    'Created By': '创建方式',
    Edited: '已编辑',
    'Threshold Configuration': '阈值配置',
  };

  return labelMap[label] || label;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}
