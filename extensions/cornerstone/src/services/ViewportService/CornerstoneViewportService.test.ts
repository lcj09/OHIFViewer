import CornerstoneViewportService from './CornerstoneViewportService';

describe('CornerstoneViewportService resize', () => {
  it('performs one immediate resize without waiting for the large-grid queue', async () => {
    const service = new CornerstoneViewportService({} as any);
    const performResize = jest
      .spyOn(service as any, 'performResize')
      .mockImplementation(() => undefined);
    const queuedTimer = setTimeout(() => undefined, 1000);

    service.viewportsById.set('petViewport', {
      getElement: () => ({ clientWidth: 320, clientHeight: 240 }),
    } as any);
    service.viewportResizeTimer = queuedTimer;
    service.resizeQueue = [false];

    service.resize(true);
    service.resize(true);

    expect(performResize).toHaveBeenCalledWith(true);
    expect(performResize).toHaveBeenCalledTimes(1);
    expect(service.resizeQueue).toEqual([]);

    await Promise.resolve();
    expect(service.immediateResizeScheduled).toBe(false);
  });
});
