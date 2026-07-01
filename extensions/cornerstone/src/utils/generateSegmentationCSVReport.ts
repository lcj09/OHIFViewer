import { utils } from '@ohif/core';

const { downloadCsv } = utils;

export function generateSegmentationCSVReport(
  segmentationData,
  info: {
    reference: {
      SeriesNumber: string;
      SeriesInstanceUID: string;
      StudyInstanceUID: string;
      SeriesDate: string;
      SeriesTime: string;
      SeriesDescription: string;
    };
  }
) {
  // Initialize the rows for our CSV
  const csvRows = [];

  // Add segmentation-level information
  csvRows.push(['分割ID', segmentationData.segmentationId || '']);
  csvRows.push(['分割标签', segmentationData.label || '']);

  csvRows.push([]);

  const additionalInfo = info.reference;
  // Add reference information
  const referenceKeys = [
    ['序列号', additionalInfo.SeriesNumber],
    ['序列UID', additionalInfo.SeriesInstanceUID],
    ['检查UID', additionalInfo.StudyInstanceUID],
    ['序列日期', additionalInfo.SeriesDate],
    ['序列时间', additionalInfo.SeriesTime],
    ['序列描述', additionalInfo.SeriesDescription],
  ];

  referenceKeys.forEach(([key, value]) => {
    if (value) {
      csvRows.push([`参考 ${key}`, value]);
    }
  });

  // Add a blank row for separation
  csvRows.push([]);

  csvRows.push(['分段统计']);

  // Add segment information in columns
  if (segmentationData.segments) {
    // First row: Segment headers
    const segmentHeaderRow = ['标签'];
    for (const segmentId in segmentationData.segments) {
      const segment = segmentationData.segments[segmentId];
      segmentHeaderRow.push(`${segment.label || ''}`);
    }
    csvRows.push(segmentHeaderRow);

    // Add segment properties
    csvRows.push([
      '分段索引',
      ...Object.values(segmentationData.segments).map(s => s.segmentIndex || ''),
    ]);
    csvRows.push([
      '锁定',
      ...Object.values(segmentationData.segments).map(s => (s.locked ? '是' : '否')),
    ]);
    csvRows.push([
      '激活',
      ...Object.values(segmentationData.segments).map(s => (s.active ? '是' : '否')),
    ]);

    // Add segment statistics
    // First, collect all unique statistics across all segments
    const allStats = new Set();
    for (const segment of Object.values(segmentationData.segments)) {
      if (segment.cachedStats && segment.cachedStats.namedStats) {
        for (const statKey in segment.cachedStats.namedStats) {
          const stat = segment.cachedStats.namedStats[statKey];
          const statLabel = stat.label || stat.name;
          const statUnit = stat.unit ? ` (${stat.unit})` : '';
          allStats.add(`${statLabel}${statUnit}`);
        }
      }
    }

    // Then create a row for each statistic
    for (const statName of allStats) {
      const statRow = [statName];

      for (const segment of Object.values(segmentationData.segments)) {
        let statValue = '';

        if (segment.cachedStats && segment.cachedStats.namedStats) {
          for (const statKey in segment.cachedStats.namedStats) {
            const stat = segment.cachedStats.namedStats[statKey];
            const currentStatName = `${stat.label || stat.name}${stat.unit ? ` (${stat.unit})` : ''}`;

            if (currentStatName === statName) {
              statValue = stat.value !== undefined ? stat.value : '';
              break;
            }
          }
        }

        statRow.push(statValue);
      }

      csvRows.push(statRow);
    }
  }

  // Convert to CSV string
  let csvString = '';
  for (const row of csvRows) {
    const formattedRow = row.map(cell => {
      // Handle values that need to be quoted (contain commas, quotes, or newlines)
      const cellValue = cell !== undefined && cell !== null ? cell.toString() : '';
      if (cellValue.includes(',') || cellValue.includes('"') || cellValue.includes('\n')) {
        // Escape quotes and wrap in quotes
        return '"' + cellValue.replace(/"/g, '""') + '"';
      }
      return cellValue;
    });
    csvString += formattedRow.join(',') + '\n';
  }

  downloadCsv(csvString, {
    filename: `${segmentationData.label || 'Segmentation'}_Report_${new Date().toISOString().split('T')[0]}.csv`,
  });
}
