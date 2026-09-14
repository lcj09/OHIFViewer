import { eventTarget } from '@cornerstonejs/core';

describe('Cornerstone debounced event listeners', () => {
  const eventName = 'TMTV_TEST_IDENTICAL_DEBOUNCED_CALLBACKS';

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps callbacks with identical source text independent', () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    const makeCallback = (value: string) =>
      function onEvent() {
        calls.push(value);
      };
    const callback1 = makeCallback('baseline');
    const callback2 = makeCallback('followup');

    expect(callback1.toString()).toBe(callback2.toString());
    eventTarget.addEventListenerDebounced(eventName, callback1, 200);
    eventTarget.addEventListenerDebounced(eventName, callback2, 200);
    eventTarget.dispatchEvent(new CustomEvent(eventName));
    jest.advanceTimersByTime(200);

    expect(calls).toEqual(['baseline', 'followup']);
    eventTarget.removeEventListener(eventName, callback1);
    eventTarget.removeEventListenerDebounced(eventName, callback2);
  });

  it('cancels a pending debounced callback when removed through the regular API', () => {
    jest.useFakeTimers();
    const callback = jest.fn();

    eventTarget.addEventListenerDebounced(eventName, callback, 200);
    eventTarget.dispatchEvent(new CustomEvent(eventName));
    eventTarget.removeEventListener(eventName, callback);
    jest.advanceTimersByTime(200);

    expect(callback).not.toHaveBeenCalled();
  });
});
