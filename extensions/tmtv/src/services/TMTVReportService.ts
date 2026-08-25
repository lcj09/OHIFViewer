import type { TMTVLesion, TMTVLesionState } from './TMTVLesionService';

export type TMTVReportSection =
  | {
      type: 'section';
      title: string;
    }
  | {
      type: 'rows';
      title?: string;
      rows: Array<[string, string | number | null | undefined]>;
    }
  | {
      type: 'table';
      title: string;
      columns: string[];
      rows: Array<Array<string | number | null | undefined>>;
    };

type CreateTMTVReportSectionsInput = {
  segReport;
  lesions: TMTVLesion[];
  lesionTotals: TMTVLesionState['totals'];
  config?: Record<string, unknown>;
  generatedAt?: Date;
};

export function createTMTVReportSections({
  segReport,
  lesions,
  lesionTotals,
  config = {},
  generatedAt = new Date(),
}: CreateTMTVReportSectionsInput): TMTVReportSection[] {
  // [2026-08-25 功能] 第四阶段将患者信息、全身汇总、逐病灶定量和阈值配置组织为正式 TMTV 报告结构
  const firstReport = segReport?.[Object.keys(segReport)[0]] ?? {};
  const confirmedLesions = lesions.filter(lesion => lesion.status === 'confirmed');
  const candidateLesions = lesions.filter(lesion => lesion.status === 'candidate');
  const rejectedLesions = lesions.filter(lesion => lesion.status === 'rejected');

  const sections: TMTVReportSection[] = [
    {
      type: 'rows',
      title: 'TMTV Report',
      rows: [
        ['Generated Time', generatedAt.toISOString()],
        ['Patient ID', getReportValue(firstReport, 'PatientID', 'patientId')],
        ['Patient Name', getReportValue(firstReport, 'PatientName', 'patientName')],
        ['Study Date', getReportValue(firstReport, 'StudyDate', 'studyDate')],
        ['Study Instance UID', getReportValue(firstReport, 'StudyInstanceUID', 'studyInstanceUID')],
        [
          'Series Instance UID',
          getReportValue(firstReport, 'SeriesInstanceUID', 'seriesInstanceUID'),
        ],
      ],
    },
    {
      type: 'rows',
      title: 'Patient-level Quantification',
      rows: [
        ['Total TMTV (mL)', formatNumber(lesionTotals?.tmtv)],
        ['Total TLG', formatNumber(lesionTotals?.tlg)],
        ['Lesion Count', lesions.length],
        ['Confirmed Lesion Count', confirmedLesions.length],
        ['Candidate Lesion Count', candidateLesions.length],
        ['Rejected Lesion Count', rejectedLesions.length],
      ],
    },
    {
      type: 'table',
      title: 'Lesion List',
      columns: [
        'Lesion',
        'Status',
        'Volume (mL)',
        'SUVmin',
        'SUVmax',
        'SUVmean',
        'TLG',
        'Center X (World)',
        'Center Y (World)',
        'Center Z (World)',
        'Bounds IJK',
        'Created By',
        'Edited',
      ],
      rows: lesions.map(lesion => [
        `Lesion ${lesion.lesionNumber}`,
        getLesionStatusLabel(lesion.status),
        formatNumber(lesion.volume),
        formatNumber(lesion.suvMin),
        formatNumber(lesion.suvMax),
        formatNumber(lesion.suvMean),
        formatNumber(lesion.tlg),
        formatNumber(lesion.centroid?.[0]),
        formatNumber(lesion.centroid?.[1]),
        formatNumber(lesion.centroid?.[2]),
        formatBounds(lesion.boundsIJK),
        lesion.createdBy,
        lesion.modified ? 'yes' : 'no',
      ]),
    },
  ];

  if (Object.keys(config).length) {
    sections.push({
      type: 'rows',
      title: 'Threshold Configuration',
      rows: Object.entries(config).map(([key, value]) => [key, stringifyValue(value)]),
    });
  }

  return sections;
}

function getLesionStatusLabel(status: TMTVLesion['status']): string {
  // [2026-08-25 功能] CSV 报告中将 lesion 状态从内部枚举值转换为中文，便于临床阅读
  if (status === 'confirmed') {
    return '已确认';
  }

  if (status === 'rejected') {
    return '已拒绝';
  }

  return '候选';
}

function getReportValue(report, ...keys: string[]): string {
  for (const key of keys) {
    const value = report?.[key];

    if (value !== undefined && value !== null) {
      return stringifyValue(value);
    }
  }

  return '';
}

function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : '';
}

function formatBounds(bounds?: TMTVLesion['boundsIJK'] | null): string {
  if (!bounds) {
    return '';
  }

  return `min ${bounds.min.join(' ')}; max ${bounds.max.join(' ')}`;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    return value.join(' ');
  }

  if (typeof value === 'object') {
    const nestedValue = (value as { value?: unknown }).value;

    if (nestedValue !== undefined) {
      return stringifyValue(nestedValue);
    }

    return JSON.stringify(value);
  }

  return String(value);
}
