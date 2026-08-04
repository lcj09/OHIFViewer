/**
 * dayjs 统一配置（替代 moment.js）
 *
 * 启用的插件：
 * - customParseFormat: 支持多格式解析，如 dayjs(date, ['YYYYMMDD', 'YYYY.MM.DD'], true)
 * - localizedFormat: 支持 MMM、Do 等本地化格式 token
 * - advancedFormat: 支持高级格式 token
 * - localeData: 支持 dayjs().locale(name)
 */
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import localeData from 'dayjs/plugin/localeData';

dayjs.extend(customParseFormat);
dayjs.extend(localizedFormat);
dayjs.extend(advancedFormat);
dayjs.extend(localeData);

// 预加载中文 locale（查询页面就会用到），其他 locale 由 i18n 切换时动态加载
import 'dayjs/locale/zh';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/ja';
import 'dayjs/locale/de';
import 'dayjs/locale/es';
import 'dayjs/locale/fr';
import 'dayjs/locale/nl';
import 'dayjs/locale/pt-br';
import 'dayjs/locale/ru';
import 'dayjs/locale/tr';
import 'dayjs/locale/vi';

export default dayjs;
