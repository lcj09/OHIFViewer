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

export function createAndDownloadTMTVReportExcel(segReport, reportSections = [], options = {}) {
  // [2026-08-26 功能] 本地 Excel 报告：纯前端生成 Excel 可打开的 .xls 文件，不依赖服务端或新增依赖
  const firstReport = segReport[Object.keys(segReport)[0]] ?? {};
  const html = createReportHTML(reportSections);

  downloadBlob(html, {
    filename: options.filename ?? `${firstReport.PatientID || 'tmtv'}_tmtv.xls`,
    type: 'application/vnd.ms-excel;charset=utf-8',
  });
}

export function openTMTVReportPrintWindow(segReport, reportSections = [], options = {}) {
  // [2026-08-26 功能] 本地 PDF 报告：用浏览器打印/另存为 PDF，保持中文字体由本机浏览器处理
  const firstReport = segReport[Object.keys(segReport)[0]] ?? {};
  const title = options.title ?? `${firstReport.PatientID || 'TMTV'} TMTV Report`;
  const reportWindow = window.open('', '_blank', 'width=1024,height=768');

  if (!reportWindow) {
    return;
  }

  reportWindow.document.write(createPrintableReportDocument(title, reportSections));
  reportWindow.document.close();
  reportWindow.focus();
  reportWindow.setTimeout(() => {
    reportWindow.print();
  }, 300);
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

function createReportHTML(reportSections) {
  const body = [];

  reportSections.forEach(section => {
    appendHTMLReportSection(body, section);
  });

  return `<!doctype html><html><head><meta charset="UTF-8"></head><body>${body.join(
    ''
  )}</body></html>`;
}

function createPrintableReportDocument(title, reportSections) {
  const body = [];

  reportSections.forEach(section => {
    appendHTMLReportSection(body, section);
  });

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHTML(title)}</title>
    <style>
      body { font-family: Arial, "Microsoft YaHei", sans-serif; color: #111827; margin: 24px; }
      h1 { font-size: 20px; margin: 0 0 16px; }
      h2 { font-size: 16px; margin: 18px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 12px; }
      th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
      th { background: #eef2ff; font-weight: 700; }
      @media print { body { margin: 12mm; } h2 { break-after: avoid; } table { break-inside: avoid; } }
    </style>
  </head>
  <body>
    <h1>${escapeHTML(translateReportLabel('TMTV Report'))}</h1>
    ${body.join('')}
  </body>
</html>`;
}

function appendHTMLReportSection(html, section) {
  if (!section) {
    return;
  }

  if (section.type === 'section') {
    html.push(`<h2>${escapeHTML(translateReportLabel(section.title))}</h2>`);
    return;
  }

  if (section.type === 'rows') {
    if (section.title) {
      html.push(`<h2>${escapeHTML(translateReportLabel(section.title))}</h2>`);
    }

    html.push('<table><tbody>');
    section.rows.forEach(([key, value]) => {
      html.push(
        `<tr><th>${escapeHTML(translateReportLabel(key))}</th><td>${escapeHTML(value)}</td></tr>`
      );
    });
    html.push('</tbody></table>');
    return;
  }

  if (section.type === 'table') {
    html.push(`<h2>${escapeHTML(translateReportLabel(section.title))}</h2>`);
    html.push('<table><thead><tr>');
    section.columns.forEach(column => {
      html.push(`<th>${escapeHTML(translateReportLabel(column))}</th>`);
    });
    html.push('</tr></thead><tbody>');
    section.rows.forEach(row => {
      html.push('<tr>');
      row.forEach(value => {
        html.push(`<td>${escapeHTML(value)}</td>`);
      });
      html.push('</tr>');
    });
    html.push('</tbody></table>');
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

function downloadBlob(content, { filename, type }) {
  const blob = new Blob(['\ufeff', content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function escapeHTML(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
