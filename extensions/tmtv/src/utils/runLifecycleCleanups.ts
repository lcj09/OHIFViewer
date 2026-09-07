export type LifecycleCleanup = {
  label: string;
  cleanup: () => void;
};

type CleanupErrorHandler = (label: string, error: unknown) => void;

const defaultErrorHandler: CleanupErrorHandler = (label, error) => {
  console.warn(`[tmtv-mode] ${label} cleanup failed`, error);
};

/**
 * 2026-09-04 功能说明：逐项执行生命周期清理，避免单个销毁异常阻断后续资源释放。
 */
export function runLifecycleCleanups(
  cleanups: LifecycleCleanup[],
  onError: CleanupErrorHandler = defaultErrorHandler
): void {
  cleanups.forEach(({ label, cleanup }) => {
    try {
      cleanup();
    } catch (error) {
      onError(label, error);
    }
  });
}

/**
 * 2026-09-04 功能说明：先移出模式订阅再逐项取消，使重复退出幂等且不误删回调中新建的订阅。
 */
export function drainLifecycleSubscriptions(
  subscriptions: Array<() => void>,
  onError: CleanupErrorHandler = defaultErrorHandler
): void {
  const pendingSubscriptions = subscriptions.splice(0, subscriptions.length);

  runLifecycleCleanups(
    pendingSubscriptions.map((unsubscribe, index) => ({
      label: `subscription ${index + 1}`,
      cleanup: unsubscribe,
    })),
    onError
  );
}
