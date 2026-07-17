import dayjs from './dayjsConfig';
import i18n from 'i18next';

/**
 * Format date
 *
 * @param {string} date Date to be formatted
 * @param {string} format Desired date format
 * @returns {string} Formatted date
 */
export default (date, format = i18n.t('Common:localDateFormat', 'DD-MMM-YYYY')) => {
  if (!date) {
    return '';
  }

  const locale = i18n.language || 'en';
  const parsed = dayjs(date, ['YYYYMMDD', 'YYYY.MM.DD'], true);

  if (!parsed.isValid()) {
    return dayjs(date).locale(locale).format(format);
  }

  return parsed.locale(locale).format(format);
};
