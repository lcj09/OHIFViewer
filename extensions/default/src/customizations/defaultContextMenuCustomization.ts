export default {
  measurementsContextMenu: {
    inheritsFrom: 'ohif.contextMenu',
    menus: [
      // Get the items from the UI Customization for the menu name (and have a custom name)
      {
        id: 'forExistingMeasurement',
        selector: ({ nearbyToolData }) => !!nearbyToolData,
        // 2026-10-09 隐藏"Add Label(添加标签)"菜单项，仅保留删除测量
        items: [
          {
            label: 'Delete measurement',
            commands: 'removeMeasurement',
          },
        ],
      },
    ],
  },
};
