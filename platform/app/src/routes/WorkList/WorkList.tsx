import React, { useState, useEffect, useMemo } from 'react';
import classnames from 'classnames';
import PropTypes from 'prop-types';
import { Link, useNavigate } from 'react-router-dom';
import qs from 'query-string';
import isEqual from 'lodash.isequal';
import { useTranslation } from 'react-i18next';
//
import filtersMeta from './filtersMeta.js';
import { useAppConfig } from '@state';
import { useDebounce, useSearchParams } from '../../hooks';
import { utils, Types as coreTypes } from '@ohif/core';

const moment = utils.dayjs;

import {
  StudyListExpandedRow,
  EmptyStudies,
  StudyListTable,
  StudyListPagination,
  StudyListFilter,
  Button,
  ButtonEnums,
} from '@ohif/ui';

import {
  Header,
  Icons,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  Clipboard,
  useModal,
  useSessionStorage,
  Onboarding,
  ScrollArea,
  InvestigationalUseDialog,
} from '@ohif/ui-next';

import { Types } from '@ohif/ui';

import { preserveQueryParameters, preserveQueryStrings } from '../../utils/preserveQueryParameters';

const PatientInfoVisibility = Types.PatientInfoVisibility;

const { sortBySeriesDate } = utils;

const seriesInStudiesMap = new Map();

/**
 * TODO:
 * - debounce `setFilterValues` (150ms?)
 */
function WorkList({
  data: studies,
  dataTotal: studiesTotal,
  isLoadingData,
  dataSource,
  hotkeysManager,
  dataPath,
  onRefresh,
  servicesManager,
}: withAppTypes) {
  const { show, hide } = useModal();
  const { t } = useTranslation();
  // ~ Modes
  const [appConfig] = useAppConfig();
  // ~ Filters
  const searchParams = useSearchParams();
  const navigate = useNavigate();
  const STUDIES_LIMIT = 101;
  const queryFilterValues = _getQueryFilterValues(searchParams);
  const [sessionQueryFilterValues, updateSessionQueryFilterValues] = useSessionStorage({
    key: 'queryFilterValues',
    defaultValue: queryFilterValues,
    // ToDo: useSessionStorage currently uses an unload listener to clear the filters from session storage
    // so on systems that do not support unload events a user will NOT be able to alter any existing filter
    // in the URL, load the page and have it apply.
    clearOnUnload: true,
  });
  const [filterValues, _setFilterValues] = useState({
    ...defaultFilterValues,
    ...sessionQueryFilterValues,
  });

  const debouncedFilterValues = useDebounce(filterValues, 200);
  const { resultsPerPage, pageNumber, sortBy, sortDirection } = filterValues;

  /*
   * The default sort value keep the filters synchronized with runtime conditional sorting
   * Only applied if no other sorting is specified and there are less than 101 studies
   */

  const canSort = studiesTotal < STUDIES_LIMIT;
  const shouldUseDefaultSort = sortBy === '' || !sortBy;
  const sortModifier = sortDirection === 'descending' ? 1 : -1;
  const defaultSortValues =
    shouldUseDefaultSort && canSort ? { sortBy: 'studyDate', sortDirection: 'ascending' } : {};
  const { customizationService } = servicesManager.services;

  const sortedStudies = useMemo(() => {
    if (!canSort) {
      return studies;
    }

    return [...studies].sort((s1, s2) => {
      if (shouldUseDefaultSort) {
        const ascendingSortModifier = -1;
        return _sortStringDates(s1, s2, ascendingSortModifier);
      }

      const s1Prop = s1[sortBy];
      const s2Prop = s2[sortBy];

      if (typeof s1Prop === 'string' && typeof s2Prop === 'string') {
        return s1Prop.localeCompare(s2Prop) * sortModifier;
      } else if (typeof s1Prop === 'number' && typeof s2Prop === 'number') {
        return (s1Prop > s2Prop ? 1 : -1) * sortModifier;
      } else if (!s1Prop && s2Prop) {
        return -1 * sortModifier;
      } else if (!s2Prop && s1Prop) {
        return 1 * sortModifier;
      } else if (sortBy === 'studyDate') {
        return _sortStringDates(s1, s2, sortModifier);
      }

      return 0;
    });
  }, [canSort, studies, shouldUseDefaultSort, sortBy, sortModifier]);

  // ~ Rows & Studies
  const [expandedRows, setExpandedRows] = useState([]);
  const [studiesWithSeriesData, setStudiesWithSeriesData] = useState([]);
  // [2026-06-26 新增] 序列复选框选中状态：Map<studyInstanceUid, Set<seriesInstanceUid>>
  const [selectedSeriesMap, setSelectedSeriesMap] = useState(new Map());
  const numOfStudies = studiesTotal;
  const querying = useMemo(() => {
    return isLoadingData || expandedRows.length > 0;
  }, [isLoadingData, expandedRows]);

  // [2026-06-26 新增] 切换单个序列选中状�?
  const handleSeriesToggle = (studyInstanceUid, seriesInstanceUid) => {
    setSelectedSeriesMap(prev => {
      const next = new Map(prev);
      const selected = next.get(studyInstanceUid) || new Set();
      if (selected.has(seriesInstanceUid)) {
        selected.delete(seriesInstanceUid);
      } else {
        selected.add(seriesInstanceUid);
      }
      next.set(studyInstanceUid, selected);
      return next;
    });
  };

  // [2026-06-26 新增] 全�?取消全选当前检查的序列
  const handleSeriesSelectAll = (studyInstanceUid, seriesList, checked) => {
    setSelectedSeriesMap(prev => {
      const next = new Map(prev);
      if (checked) {
        const allUids = new Set(seriesList.map(s => s.seriesInstanceUid));
        next.set(studyInstanceUid, allUids);
      } else {
        next.delete(studyInstanceUid);
      }
      return next;
    });
  };

  // [2026-06-26 新增] 启动TMTV，只加载选中的两个序�?
  const handleLaunchTMTV = (studyInstanceUid, selectedSeriesUids) => {
    const query = new URLSearchParams();
    if (filterValues.configUrl) {
      query.append('configUrl', filterValues.configUrl);
    }
    query.append('StudyInstanceUIDs', studyInstanceUid);
    // 传递选中的序列UID，用逗号分隔
    query.append('SeriesInstanceUIDs', selectedSeriesUids.join(','));
    preserveQueryParameters(query);

    // 跳转到TMTV模式
    const tmtvMode = appConfig.loadedModes?.find(m => m.routeName === 'tmtv');
    if (tmtvMode) {
      window.location.href = `${tmtvMode.routeName}${dataPath || ''}?${query.toString()}`;
    }
  };

  const setFilterValues = val => {
    if (filterValues.pageNumber === val.pageNumber) {
      val.pageNumber = 1;
    }
    _setFilterValues(val);
    updateSessionQueryFilterValues(val);
    setExpandedRows([]);
  };

  const onPageNumberChange = newPageNumber => {
    const oldPageNumber = filterValues.pageNumber;
    const rollingPageNumberMod = Math.floor(101 / filterValues.resultsPerPage);
    const rollingPageNumber = oldPageNumber % rollingPageNumberMod;
    const isNextPage = newPageNumber > oldPageNumber;
    const hasNextPage = Math.max(rollingPageNumber, 1) * resultsPerPage < numOfStudies;

    if (isNextPage && !hasNextPage) {
      return;
    }

    setFilterValues({ ...filterValues, pageNumber: newPageNumber });
  };

  const onResultsPerPageChange = newResultsPerPage => {
    setFilterValues({
      ...filterValues,
      pageNumber: 1,
      resultsPerPage: Number(newResultsPerPage),
    });
  };

  // Set body style
  useEffect(() => {
    document.body.classList.add('bg-black');
    return () => {
      document.body.classList.remove('bg-black');
    };
  }, []);

  // Sync URL query parameters with filters
  useEffect(() => {
    if (!debouncedFilterValues) {
      return;
    }

    const queryString = {};
    Object.keys(defaultFilterValues).forEach(key => {
      const defaultValue = defaultFilterValues[key];
      const currValue = debouncedFilterValues[key];

      // TODO: nesting/recursion?
      if (key === 'studyDate') {
        if (currValue.startDate && defaultValue.startDate !== currValue.startDate) {
          queryString.startDate = currValue.startDate;
        }
        if (currValue.endDate && defaultValue.endDate !== currValue.endDate) {
          queryString.endDate = currValue.endDate;
        }
      } else if (key === 'modalities' && currValue.length) {
        queryString.modalities = currValue.join(',');
      } else if (currValue !== defaultValue) {
        queryString[key] = currValue;
      }
    });

    preserveQueryStrings(queryString);

    const search = qs.stringify(queryString, {
      skipNull: true,
      skipEmptyString: true,
    });
    //构建查询字符�?
    navigate({
      pathname: '/',
      search: search ? `?${search}` : undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedFilterValues]);

  // Query for series information
  useEffect(() => {
    const fetchSeries = async studyInstanceUid => {
      try {
        const series = await dataSource.query.series.search(studyInstanceUid);
        seriesInStudiesMap.set(studyInstanceUid, sortBySeriesDate(series));
        setStudiesWithSeriesData([...studiesWithSeriesData, studyInstanceUid]);
      } catch (ex) {
        // TODO: UI Notification Service
        console.warn(ex);
      }
    };

    // TODO: WHY WOULD YOU USE AN INDEX OF 1?!
    // Note: expanded rows index begins at 1
    for (let z = 0; z < expandedRows.length; z++) {
      const expandedRowIndex = expandedRows[z] - 1;
      const studyInstanceUid = sortedStudies[expandedRowIndex].studyInstanceUid;

      if (studiesWithSeriesData.includes(studyInstanceUid)) {
        continue;
      }

      fetchSeries(studyInstanceUid);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedRows, studies]);

  const isFiltering = (filterValues, defaultFilterValues) => {
    return !isEqual(filterValues, defaultFilterValues);
  };

  const rollingPageNumberMod = Math.floor(101 / resultsPerPage);
  const rollingPageNumber = (pageNumber - 1) % rollingPageNumberMod;
  const offset = resultsPerPage * rollingPageNumber;
  const offsetAndTake = offset + resultsPerPage;
  const tableDataSource = sortedStudies.map((study, key) => {
    const rowKey = key + 1;
    const isExpanded = expandedRows.some(k => k === rowKey);
    const {
      studyInstanceUid,
      accession,
      modalities,
      instances,
      description,
      mrn,
      patientName,
      date,
      time,
    } = study;
    const studyDate =
      date &&
      moment(date, ['YYYYMMDD', 'YYYY.MM.DD'], true).isValid() &&
      moment(date, ['YYYYMMDD', 'YYYY.MM.DD']).format(t('Common:localDateFormat', 'MMM-DD-YYYY'));
    const studyTime =
      time &&
      moment(time, ['HH', 'HHmm', 'HHmmss', 'HHmmss.SSS']).isValid() &&
      moment(time, ['HH', 'HHmm', 'HHmmss', 'HHmmss.SSS']).format(
        t('Common:localTimeFormat', 'hh:mm A')
      );

    const makeCopyTooltipCell = textValue => {
      if (!textValue) {
        return '';
      }
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-pointer truncate">{textValue}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="flex items-center justify-between gap-2">
              {textValue}
              <Clipboard>{textValue}</Clipboard>
            </div>
          </TooltipContent>
        </Tooltip>
      );
    };

    return {
      dataCY: `studyRow-${studyInstanceUid}`,
      clickableCY: studyInstanceUid,
      row: [
        {
          key: 'patientName',
          content: patientName ? makeCopyTooltipCell(patientName) : null,
          gridCol: 4,
        },
        {
          key: 'mrn',
          content: makeCopyTooltipCell(mrn),
          gridCol: 3,
        },
        {
          key: 'studyDate',
          content: (
            <>
              {studyDate && <span className="mr-4">{studyDate}</span>}
              {studyTime && <span>{studyTime}</span>}
            </>
          ),
          title: `${studyDate || ''} ${studyTime || ''}`,
          gridCol: 5,
        },
        {
          key: 'description',
          content: makeCopyTooltipCell(description),
          gridCol: 4,
        },
        {
          key: 'modality',
          content: modalities,
          title: modalities,
          gridCol: 3,
        },
        {
          key: 'accession',
          content: makeCopyTooltipCell(accession),
          gridCol: 3,
        },
        {
          key: 'instances',
          content: (
            <>
              <Icons.GroupLayers
                className={classnames('mr-2 inline-flex w-4', {
                  'text-primary': isExpanded,
                  'text-secondary-light': !isExpanded,
                })}
              />
              {instances}
            </>
          ),
          title: (instances || 0).toString(),
          gridCol: 2,
        },
      ],
      // Todo: This is actually running for all rows, even if they are
      // not clicked on.
      expandedContent: (
        <StudyListExpandedRow
          seriesTableColumns={{
            description: t('StudyList:Description'),
            seriesNumber: t('StudyList:Series'),
            modality: t('StudyList:Modality'),
            instances: t('StudyList:Instances'),
          }}
          selectedSeries={selectedSeriesMap.get(studyInstanceUid) || new Set()}
          onSeriesToggle={(seriesInstanceUid) => handleSeriesToggle(studyInstanceUid, seriesInstanceUid)}
          onLaunchTMTV={(selectedSeriesUids) => handleLaunchTMTV(studyInstanceUid, selectedSeriesUids)}
          seriesTableDataSource={
            seriesInStudiesMap.has(studyInstanceUid)
              ? seriesInStudiesMap.get(studyInstanceUid).map(s => {
                  return {
                    seriesInstanceUid: s.seriesInstanceUid,
                    description: s.description || '(�?',
                    seriesNumber: s.seriesNumber ?? '',
                    modality: s.modality || '',
                    instances: s.numSeriesInstances || '',
                  };
                })
              : []
          }
        />
      ),
      onClickRow: () =>
        setExpandedRows(s => (isExpanded ? s.filter(n => rowKey !== n) : [...s, rowKey])),
      isExpanded,
    };
  });

  const hasStudies = numOfStudies > 0;

  const AboutModal = customizationService.getCustomization(
    'ohif.aboutModal'
  ) as coreTypes.MenuComponentCustomization;
  const UserPreferencesModal = customizationService.getCustomization(
    'ohif.userPreferencesModal'
  ) as coreTypes.MenuComponentCustomization;

  const menuOptions = [
    // 暂时屏蔽"关于"按钮
    // {
    //   title: AboutModal?.menuTitle ?? t('Header:About'),
    //   icon: 'info',
    //   onClick: () =>
    //     show({
    //       content: AboutModal,
    //       title: AboutModal?.title ?? t('AboutModal:About OHIF Viewer'),
    //       containerClassName: AboutModal?.containerClassName ?? 'max-w-md',
    //     }),
    // },
    {
      title: UserPreferencesModal.menuTitle ?? t('Header:Preferences'),
      icon: 'settings',
      onClick: () =>
        show({
          content: UserPreferencesModal as React.ComponentType,
          title: UserPreferencesModal.title ?? t('UserPreferencesModal:User preferences'),
          containerClassName:
            UserPreferencesModal?.containerClassName ?? 'flex max-w-4xl p-6 flex-col',
        }),
    },
  ];

  if (appConfig.oidc) {
    menuOptions.push({
      icon: 'power-off',
      title: t('Header:Logout'),
      onClick: () => {
        navigate(`/logout?redirect_uri=${encodeURIComponent(window.location.href)}`);
      },
    });
  }

  const LoadingIndicatorProgress = customizationService.getCustomization(
    'ui.loadingIndicatorProgress'
  );
  const DicomUploadComponent = customizationService.getCustomization('dicomUploadComponent');

  const uploadProps =
    DicomUploadComponent && dataSource.getConfig()?.dicomUploadEnabled
      ? {
          title: '上传文件',
          containerClassName: DicomUploadComponent?.containerClassName,
          closeButton: true,
          shouldCloseOnEsc: false,
          shouldCloseOnOverlayClick: false,
          content: () => (
            <DicomUploadComponent
              dataSource={dataSource}
              onComplete={() => {
                hide();
                onRefresh();
              }}
              onStarted={() => {
                show({
                  ...uploadProps,
                  // when upload starts, hide the default close button as closing the dialogue must be handled by the upload dialogue itself
                  closeButton: false,
                });
              }}
            />
          ),
        }
      : undefined;

  const dataSourceConfigurationComponent = customizationService.getCustomization(
    'ohif.dataSourceConfigurationComponent'
  );

  return (
    <div className="flex h-screen flex-col bg-black">
      <Header
        isSticky
        menuOptions={menuOptions}
        isReturnEnabled={false}
        WhiteLabeling={appConfig.whiteLabeling}
        showPatientInfo={PatientInfoVisibility.DISABLED}
      />
      <Onboarding />
      <InvestigationalUseDialog dialogConfiguration={appConfig?.investigationalUseDialog} />
      <div className="flex h-full flex-col overflow-y-auto">
        <ScrollArea>
          <div className="flex grow flex-col">
            <StudyListFilter
              numOfStudies={pageNumber * resultsPerPage > 100 ? 101 : numOfStudies}
              filtersMeta={filtersMeta}
              filterValues={{ ...filterValues, ...defaultSortValues }}
              onChange={setFilterValues}
              clearFilters={() => setFilterValues(defaultFilterValues)}
              isFiltering={isFiltering(filterValues, defaultFilterValues)}
              onUploadClick={uploadProps ? () => show(uploadProps) : undefined}
              getDataSourceConfigurationComponent={
                dataSourceConfigurationComponent
                  ? () => dataSourceConfigurationComponent()
                  : undefined
              }
            />
          </div>
          {hasStudies ? (
            <div className="flex grow flex-col">
              <StudyListTable
                tableDataSource={tableDataSource.slice(offset, offsetAndTake)}
                numOfStudies={numOfStudies}
                querying={querying}
                filtersMeta={filtersMeta}
              />
              <div className="grow">
                <StudyListPagination
                  onChangePage={onPageNumberChange}
                  onChangePerPage={onResultsPerPageChange}
                  currentPage={pageNumber}
                  perPage={resultsPerPage}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center pt-48">
              {appConfig.showLoadingIndicator && isLoadingData ? (
                <LoadingIndicatorProgress className={'h-full w-full bg-black'} />
              ) : (
                <EmptyStudies />
              )}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

WorkList.propTypes = {
  data: PropTypes.array.isRequired,
  dataSource: PropTypes.shape({
    query: PropTypes.object.isRequired,
    getConfig: PropTypes.func,
  }).isRequired,
  isLoadingData: PropTypes.bool.isRequired,
  servicesManager: PropTypes.object.isRequired,
};

const defaultFilterValues = {
  patientName: '',
  mrn: '',
  studyDate: {
    startDate: null,
    endDate: null,
  },
  description: '',
  modalities: [],
  accession: '',
  sortBy: '',
  sortDirection: 'none',
  pageNumber: 1,
  resultsPerPage: 25,
  datasources: '',
};

function _tryParseInt(str, defaultValue) {
  let retValue = defaultValue;
  if (str && str.length > 0) {
    if (!isNaN(str)) {
      retValue = parseInt(str);
    }
  }
  return retValue;
}

function _getQueryFilterValues(params) {
  const newParams = new URLSearchParams();
  for (const [key, value] of params) {
    newParams.set(key.toLowerCase(), value);
  }
  params = newParams;

  const queryFilterValues = {
    patientName: params.get('patientname'),
    mrn: params.get('mrn'),
    studyDate: {
      startDate: params.get('startdate') || null,
      endDate: params.get('enddate') || null,
    },
    description: params.get('description'),
    modalities: params.get('modalities') ? params.get('modalities').split(',') : [],
    accession: params.get('accession'),
    sortBy: params.get('sortby'),
    sortDirection: params.get('sortdirection'),
    pageNumber: _tryParseInt(params.get('pagenumber'), undefined),
    resultsPerPage: _tryParseInt(params.get('resultsperpage'), undefined),
    datasources: params.get('datasources'),
    configUrl: params.get('configurl'),
  };

  // Delete null/undefined keys
  Object.keys(queryFilterValues).forEach(
    key => queryFilterValues[key] == null && delete queryFilterValues[key]
  );

  return queryFilterValues;
}

function _sortStringDates(s1, s2, sortModifier) {
  // TODO: Delimiters are non-standard. Should we support them?
  const s1Date = moment(s1.date, ['YYYYMMDD', 'YYYY.MM.DD'], true);
  const s2Date = moment(s2.date, ['YYYYMMDD', 'YYYY.MM.DD'], true);

  if (s1Date.isValid() && s2Date.isValid()) {
    return (s1Date.toISOString() > s2Date.toISOString() ? 1 : -1) * sortModifier;
  } else if (s1Date.isValid()) {
    return sortModifier;
  } else if (s2Date.isValid()) {
    return -1 * sortModifier;
  }
}

export default WorkList;
