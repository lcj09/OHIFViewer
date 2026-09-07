import { drainLifecycleSubscriptions, runLifecycleCleanups } from './runLifecycleCleanups';

describe('TMTV lifecycle cleanup helpers', () => {
  it('continues cleanup after one step throws', () => {
    const calls: string[] = [];
    const onError = jest.fn();

    runLifecycleCleanups(
      [
        { label: 'first', cleanup: () => calls.push('first') },
        {
          label: 'broken',
          cleanup: () => {
            throw new Error('failed');
          },
        },
        { label: 'last', cleanup: () => calls.push('last') },
      ],
      onError
    );

    expect(calls).toEqual(['first', 'last']);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('drains subscriptions before invoking them and remains idempotent', () => {
    const subscriptions: Array<() => void> = [];
    const replacement = jest.fn();
    const first = jest.fn(() => subscriptions.push(replacement));
    subscriptions.push(first);

    drainLifecycleSubscriptions(subscriptions);

    expect(first).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(subscriptions).toEqual([replacement]);

    drainLifecycleSubscriptions(subscriptions);
    drainLifecycleSubscriptions(subscriptions);

    expect(replacement).toHaveBeenCalledTimes(1);
    expect(subscriptions).toHaveLength(0);
  });
});
