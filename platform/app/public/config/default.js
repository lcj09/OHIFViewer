/** @type {AppTypes.Config} */

window.config = {
  name: 'config/default.js',
  routerBasename: null,
  // whiteLabeling: {},
  extensions: [],
  modes: [],
  customizationService: {
    // TMTV模式图像上传服务地址
    // 部署时只需修改此处的apiUrl即可，无需改动源码
    'tmtv.imageUpload': {
      apiUrl: 'http://192.168.103.89:8028/api/fileUpload',
    },
  },
  showStudyList: true,
  investigationalUseDialog: {
    option: 'never',
  },
  // some windows systems have issues with more than 3 web workers
  maxNumberOfWebWorkers: 3,
  // below flag is for performance reasons, but it might not work for all servers
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  experimentalStudyBrowserSort: false,
  strictZSpacingForVolumeViewport: true,
  // [2026-07-08 WebGL内存优化] TMTV模式仅4个视口，减少WebGL上下文数量(默认7个)
  // [2026-07-27 GPU显存优化] 从4降到1：每个WebGL上下文都会复制一份volume纹理(CT+PT)，
  // 4个上下文导致GPU显存5-8GB；1个上下文所有viewport共享纹理，显存降到1.5-2GB。
  // MIP 3D旋转是相机操作，不依赖上下文数量，功能不受影响。
  webGlContextCount: 1,
  // [2026-07-27 内存动态优化] 根据设备内存动态设置 maxCacheSize，适配集显电脑
  // navigator.deviceMemory 返回设备内存(GB)，仅 Chrome 系支持；不支持时回退到 16GB 档位
  // 策略：≤8GB 给 512MB；≤16GB 给 1.5GB；>16GB 给 2.5GB
  maxCacheSize: (() => {
    const deviceMemoryGB = navigator.deviceMemory || 16;
    const GB = 1024 * 1024 * 1024;
    if (deviceMemoryGB <= 8) return 0.5 * GB;
    if (deviceMemoryGB <= 16) return 1.5 * GB;
    return 2.5 * GB;
  })(),
  groupEnabledModesFirst: true,
  allowMultiSelectExport: false,
  maxNumRequests: {
    interaction: 100,
    // [2026-07-22 内存优化] 从75降到25，减少缩略图并发请求
    thumbnail: 25,
    // 2026-09-09 功能说明：与3个解码 Worker 对齐，
    // 避免每个 Worker 外再积压一份大切片上传缓冲。
    prefetch: 6,
  },
  showErrorDetails: 'always', // 'always', 'dev', 'production'
  // filterQueryParam: false,
  // Defines multi-monitor layouts
  multimonitor: [
    {
      id: 'split',
      test: ({ multimonitor }) => multimonitor === 'split',
      screens: [
        {
          id: 'ohif0',
          screen: null,
          location: {
            screen: 0,
            width: 0.5,
            height: 1,
            left: 0,
            top: 0,
          },
          options: 'location=no,menubar=no,scrollbars=no,status=no,titlebar=no',
        },
        {
          id: 'ohif1',
          screen: null,
          location: {
            width: 0.5,
            height: 1,
            left: 0.5,
            top: 0,
          },
          options: 'location=no,menubar=no,scrollbars=no,status=no,titlebar=no',
        },
      ],
    },

    {
      id: '2',
      test: ({ multimonitor }) => multimonitor === '2',
      screens: [
        {
          id: 'ohif0',
          screen: 0,
          location: {
            width: 1,
            height: 1,
            left: 0,
            top: 0,
          },
          options: 'fullscreen=yes,location=no,menubar=no,scrollbars=no,status=no,titlebar=no',
        },
        {
          id: 'ohif1',
          screen: 1,
          location: {
            width: 1,
            height: 1,
            left: 0,
            top: 0,
          },
          options: 'fullscreen=yes,location=no,menubar=no,scrollbars=no,status=no,titlebar=no',
        },
      ],
    },
  ],
  //defaultDataSourceName: 'ohif',
  //defaultDataSourceName: 'orthanc',
  defaultDataSourceName: 'pacs', // [2026-11-04] 切换到自定义 PACS 服务端
  /* Dynamic config allows user to pass "configUrl" query string this allows to load config without recompiling application. The regex will ensure valid configuration source */
  // dangerouslyUseDynamicConfig: {
  //   enabled: true,
  //   // regex will ensure valid configuration source and default is /.*/ which matches any character. To use this, setup your own regex to choose a specific source of configuration only.
  //   // Example 1, to allow numbers and letters in an absolute or sub-path only.
  //   // regex: /(0-9A-Za-z.]+)(\/[0-9A-Za-z.]+)*/
  //   // Example 2, to restricts to either hosptial.com or othersite.com.
  //   // regex: /(https:\/\/hospital.com(\/[0-9A-Za-z.]+)*)|(https:\/\/othersite.com(\/[0-9A-Za-z.]+)*)/
  //   regex: /.*/,
  // },
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'ohif',
      configuration: {
        friendlyName: 'AWS S3 Static wado server',
        name: 'aws',
        wadoUriRoot: 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
        qidoRoot: 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
        wadoRoot: 'https://d14fa38qiwhyfd.cloudfront.net/dicomweb',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: true,
        supportsWildcard: false,
        staticWado: true,
        singlepart: 'bulkdata,video',
        // whether the data source should use retrieveBulkData to grab metadata,
        // and in case of relative path, what would it be relative to, options
        // are in the series level or study level (some servers like series some study)
        bulkDataURI: {
          enabled: true,
          relativeResolution: 'studies',
          transform: url => url.replace('/pixeldata.mp4', '/rendered'),
        },
        omitQuotationForMultipartRequest: true,
      },
    },

    /*{
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'ohif2',
      configuration: {
        friendlyName: 'AWS S3 Static wado secondary server',
        name: 'aws',
        wadoUriRoot: 'https://dd14fa38qiwhyfd.cloudfront.net/dicomweb',
        qidoRoot: 'https://dd14fa38qiwhyfd.cloudfront.net/dicomweb',
        wadoRoot: 'https://dd14fa38qiwhyfd.cloudfront.net/dicomweb',
        qidoSupportsIncludeField: false,
        supportsReject: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
        staticWado: true,
        singlepart: 'bulkdata,video',
        // whether the data source should use retrieveBulkData to grab metadata,
        // and in case of relative path, what would it be relative to, options
        // are in the series level or study level (some servers like series some study)
        bulkDataURI: {
          enabled: true,
          relativeResolution: 'studies',
        },
        omitQuotationForMultipartRequest: true,
      },
    },
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'ohif3',
      configuration: {
        friendlyName: 'AWS S3 Static wado secondary server',
        name: 'aws',
        wadoUriRoot: 'https://d3t6nz73ql33tx.cloudfront.net/dicomweb',
        qidoRoot: 'https://d3t6nz73ql33tx.cloudfront.net/dicomweb',
        wadoRoot: 'https://d3t6nz73ql33tx.cloudfront.net/dicomweb',
        qidoSupportsIncludeField: false,
        supportsReject: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
        staticWado: true,
        singlepart: 'bulkdata,video',
        // whether the data source should use retrieveBulkData to grab metadata,
        // and in case of relative path, what would it be relative to, options
        // are in the series level or study level (some servers like series some study)
        bulkDataURI: {
          enabled: true,
          relativeResolution: 'studies',
        },
        omitQuotationForMultipartRequest: true,
      },
    },

    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'local5000',
      configuration: {
        friendlyName: 'Static WADO Local Data',
        name: 'DCM4CHEE',
        qidoRoot: 'http://localhost:5000/dicomweb',
        wadoRoot: 'http://localhost:5000/dicomweb',
        qidoSupportsIncludeField: false,
        supportsReject: true,
        supportsStow: true,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
        staticWado: true,
        singlepart: 'video',
        bulkDataURI: {
          enabled: true,
          relativeResolution: 'studies',
        },
      },
    },*/
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'orthanc',
      configuration: {
        //friendlyName: 'local Orthanc DICOMWeb Server',
        //name: 'DCM4CHEE',
        //wadoUriRoot: 'http://localhost/pacs/dicom-web',
        //qidoRoot: 'http://localhost/pacs/dicom-web',
        //wadoRoot: 'http://localhost/pacs/dicom-web',
         friendlyName: 'local Orthanc Server',
        name: 'Orthanc',
        // [2026-11-03 切换WADO-URI模式] 以下为原WADO-RS配置，注释保留以便回切
         //wadoUriRoot: '/dicomweb/wado',//解决跨域
         //qidoRoot: '/dicomweb',
         //wadoRoot: '/dicomweb',
        //qidoSupportsIncludeField: false,
         //supportsReject: true,
        // dicomUploadEnabled: true,
         //imageRendering: 'wadors',
         //thumbnailRendering: 'wadors',
        // enableStudyLazyLoad: true,
         //supportsFuzzyMatching: true,
         //supportsWildcard: true,
        //omitQuotationForMultipartRequest: true,
        // WADO-URI 模式配置
        wadoUriRoot: '/dicomweb/wado',// WADO-URI 接口根路径，buildInstanceWadoUrl 会拼接 ?requestType=WADO&...
        qidoRoot: '/dicomweb',
        wadoRoot: '/dicomweb',
        qidoSupportsIncludeField: false,
        supportsReject: true,
        dicomUploadEnabled: true,
        imageRendering: 'wadouri',
        thumbnailRendering: 'wadouri',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: true,
        supportsWildcard: true,
       omitQuotationForMultipartRequest: true,

        bulkDataURI: {
          enabled: true,
          // This is an example config that can be used to fix the retrieve URL
          // where it has the wrong prefix (eg a canned prefix).  It is better to
          // just use the correct prefix out of the box, but that is sometimes hard
          // when URLs go through several systems.
          // Example URLS are:
          // "BulkDataURI" : "http://localhost/dicom-web/studies/1.2.276.0.7230010.3.1.2.2344313775.14992.1458058363.6979/series/1.2.276.0.7230010.3.1.3.1901948703.36080.1484835349.617/instances/1.2.276.0.7230010.3.1.4.1901948703.36080.1484835349.618/bulk/00420011",
          // when running on http://localhost:3003 with no server running on localhost.  This can be corrected to:
          // /orthanc/dicom-web/studies/1.2.276.0.7230010.3.1.2.2344313775.14992.1458058363.6979/series/1.2.276.0.7230010.3.1.3.1901948703.36080.1484835349.617/instances/1.2.276.0.7230010.3.1.4.1901948703.36080.1484835349.618/bulk/00420011
          // which is a valid relative URL, and will result in using the http://localhost:3003/orthanc/.... path
          // startsWith: 'http://localhost/',
          // prefixWith: '/orthanc/',
        },
      },
    },

    // [2026-11-04] 自定义 PACS 服务端数据源（保留 Orthanc 配置不动）
    // 相对路径，由 nginx 代理转发到 PACS 服务端
    // 前缀 /pacs/dicomweb 与 Orthanc 的 /dicomweb 区分，nginx 按前缀分流
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'pacs',
      configuration: {
        friendlyName: 'PACS Server',
        name: 'PACS',
        // [2026-11-04] 以下为原 WADO-RS 配置，注释保留以便回切
         qidoRoot: '/pacs/dicomweb',     // WADO-RS：nginx 转发到 PACS:8042/dicom-web
         wadoRoot: '/pacs/dicomweb',     // WADO-RS：nginx 转发到 PACS:8042/dicom-web
         qidoSupportsIncludeField: true,
         supportsFuzzyMatching: true,
         supportsWildcard: true,
         imageRendering: 'wadors',
         thumbnailRendering: 'wadors',
         // [2026-11-20] lazyLoad 实测在 HDD 服务器上负载涨 9 倍（18 次序列级请求 vs Sync 模式 1 次全量，
         // 且缩略图路径与序列加载路径不去重导致每序列重复请求 2 遍），回退为 false 走一次性全量 metadata
         enableStudyLazyLoad: false,
        // WADO-URI 模式配置（优先使用）
        // QIDO-RS 和 metadata 仍走 WADO-RS（端口 8042，路径 /dicom-web）
        // 像素数据走 WADO-URI（端口 1000，路径 /test）
        //qidoRoot: '/pacs/dicomweb',              // QIDO-RS / metadata：PACS:8042/dicom-web
        //wadoRoot: '/pacs/dicomweb',              // WADO-RS metadata：PACS:8042/dicom-web
        //wadoUriRoot: '/pacs/dicomweb/test',      // WADO-URI 像素数据：PACS:1000/test
        //qidoSupportsIncludeField: true,
        //supportsFuzzyMatching: true,
        //supportsWildcard: true,
        //imageRendering: 'wadouri',               // ← WADO-URI 模式
        //thumbnailRendering: 'wadouri',           // ← WADO-URI 模式
        //enableStudyLazyLoad: false,
      },
    },

   /* {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomwebproxy',
      sourceName: 'dicomwebproxy',
      configuration: {
        friendlyName: 'dicomweb delegating proxy',
        name: 'dicomwebproxy',
      },
    },
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomjson',
      sourceName: 'dicomjson',
      configuration: {
        friendlyName: 'dicom json',
        name: 'json',
      },
    },
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
      sourceName: 'dicomlocal',
      configuration: {
        friendlyName: 'dicom local',
      },
    },*/
  ],
  httpErrorHandler: error => {
    // This is 429 when rejected from the public idc sandbox too often.
    console.warn(error.status);

    // Could use services manager here to bring up a dialog/modal if needed.
    console.warn('test, navigate to https://ohif.org/');
  },
  // segmentation: {
  //   segmentLabel: {
  //     enabledByDefault: true,
  //     labelColor: [255, 255, 0, 1], // must be an array
  //     hoverTimeout: 1,
  //     background: 'rgba(100, 100, 100, 0.5)', // can be any valid css color
  //   },
  // },
  // whiteLabeling: {
  //   createLogoComponentFn: function (React) {
  //     return React.createElement(
  //       'a',
  //       {
  //         target: '_self',
  //         rel: 'noopener noreferrer',
  //         className: 'text-purple-600 line-through',
  //         href: '_X___IDC__LOGO__LINK___Y_',
  //       },
  //       React.createElement('img', {
  //         src: './Logo.svg',
  //         className: 'w-14 h-14',
  //       })
  //     );
  //   },
  // },
};
