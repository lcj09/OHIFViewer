import * as csTools from '@cornerstonejs/tools';

type NumericArray = ArrayLike<number>;

export type PersistedSegmentMask = {
  version: 1;
  storageKey: string;
  segmentationId: string;
  segmentationVolumeId: string;
  segmentIndex: number;
  dimensions: [number, number, number];
  geometryFingerprint: string | null;
  voxelIndices: Uint32Array;
  voxelCount: number;
  updatedAt: number;
};

export type SegmentMaskStorageInfo = {
  storageKey: string;
  segmentIndex: number;
  dimensions: [number, number, number];
  voxelCount: number;
  updatedAt: number;
  geometryFingerprint: string | null;
};

type SegmentMaskContext = {
  segmentationId: string;
  segmentationVolumeId: string;
  segmentationVolume?: any;
  segmentIndex: number;
  dimensions: [number, number, number];
};

type SaveSegmentMaskInput = SegmentMaskContext & {
  scalarData: NumericArray;
};

type ReferenceVolumeMaskContext = {
  referenceVolume: any;
  segmentIndex: number;
  dimensions: [number, number, number];
};

const DB_NAME = 'ohif-tmtv-segment-mask';
const STORE_NAME = 'segmentMasks';
const DB_VERSION = 1;
const SAVE_DEBOUNCE_MS = 800;
const MAX_PERSISTED_SEGMENT_VOXELS = 300000;

class TMTVSegmentMaskStorageService {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private saveTimeoutByKey = new Map<string, ReturnType<typeof setTimeout>>();

  public async loadSegmentMask(context: SegmentMaskContext): Promise<PersistedSegmentMask | null> {
    // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：读取时校验维度，避免恢复到不匹配的图像
    const db = await this.getDatabase();
    const storageKeys = this.createStorageKeys(context);

    if (!db || !storageKeys.length) {
      return null;
    }

    try {
      for (const storageKey of storageKeys) {
        const record = await getFromStore<PersistedSegmentMask>(db, storageKey);
        const geometryFingerprint = createGeometryFingerprint(context);

        if (
          record &&
          record.version === 1 &&
          record.segmentIndex === context.segmentIndex &&
          areDimensionsEqual(record.dimensions, context.dimensions) &&
          !!record.geometryFingerprint &&
          record.geometryFingerprint === geometryFingerprint &&
          record.voxelIndices?.length
        ) {
          return record;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  public async hasSegmentMaskForReferenceVolume({
    referenceVolume,
    segmentIndex,
    dimensions,
  }: ReferenceVolumeMaskContext): Promise<boolean> {
    // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：自动创建空分割前先探测是否确有本地 mask，避免无意义创建导致图像/工具状态异常
    return !!(await this.getSegmentMaskInfoForReferenceVolume({
      referenceVolume,
      segmentIndex,
      dimensions,
    }));
  }

  public async getSegmentMaskInfoForReferenceVolume({
    referenceVolume,
    segmentIndex,
    dimensions,
  }: ReferenceVolumeMaskContext): Promise<SegmentMaskStorageInfo | null> {
    // [2026-08-27 功能] 本地存储管理 UI：读取当前病例 Segment 1 本地 mask 摘要，避免面板直接加载大体素数组
    const record = await this.findSegmentMaskForReferenceVolume({
      referenceVolume,
      segmentIndex,
      dimensions,
    });

    if (!record) {
      return null;
    }

    return {
      storageKey: record.storageKey,
      segmentIndex: record.segmentIndex,
      dimensions: record.dimensions,
      voxelCount: record.voxelCount,
      updatedAt: record.updatedAt,
      geometryFingerprint: record.geometryFingerprint,
    };
  }

  public async deleteSegmentMaskForReferenceVolume({
    referenceVolume,
    segmentIndex,
    dimensions,
  }: ReferenceVolumeMaskContext): Promise<boolean> {
    // [2026-08-27 功能] 本地存储管理 UI：清除当前病例本地 mask，并取消待保存任务，避免删除后被防抖写入重新保存
    const db = await this.getDatabase();
    const storageKeys = this.createStorageKeysFromReferenceVolume(referenceVolume, segmentIndex);

    this.clearScheduledSaves(storageKeys);

    if (!db || !storageKeys.length) {
      return false;
    }

    const geometryFingerprint = createGeometryFingerprint({ referenceVolume, dimensions });

    try {
      return await this.deleteSegmentMaskRecordsForGeometry(db, storageKeys, {
        segmentIndex,
        dimensions,
        geometryFingerprint,
      });
    } catch {
      return false;
    }
  }

  public scheduleSaveSegmentMask(input: SaveSegmentMaskInput): void {
    // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：分割编辑后延迟写入，避免 Brush/Eraser 每一笔都阻塞主线程
    const storageKeys = this.createStorageKeys(input);
    const primaryStorageKey = storageKeys[0];

    if (!primaryStorageKey) {
      return;
    }

    this.clearScheduledSaves(storageKeys);

    const timeout = setTimeout(() => {
      this.saveTimeoutByKey.delete(primaryStorageKey);
      this.persistSegmentMask(input, storageKeys);
    }, SAVE_DEBOUNCE_MS);

    this.saveTimeoutByKey.set(primaryStorageKey, timeout);
  }

  public async saveSegmentMask(input: SaveSegmentMaskInput): Promise<void> {
    // [2026-08-27 功能] 本地存储管理 UI：删除 lesion 后立即写入/清空本地 mask，避免刷新早于防抖保存导致旧 mask 被恢复
    const storageKeys = this.createStorageKeys(input);

    if (!storageKeys.length) {
      return;
    }

    this.clearScheduledSaves(storageKeys);
    await this.persistSegmentMask(input, storageKeys);
  }

  private async persistSegmentMask(
    input: SaveSegmentMaskInput,
    storageKeys: string[]
  ): Promise<void> {
    const db = await this.getDatabase();

    if (!db) {
      return;
    }

    try {
      const voxelIndices = collectSegmentVoxelIndices(
        input.scalarData,
        input.segmentIndex,
        MAX_PERSISTED_SEGMENT_VOXELS
      );

      if (!voxelIndices?.length) {
        await this.deleteSegmentMaskRecordsForGeometry(db, storageKeys, {
          segmentIndex: input.segmentIndex,
          dimensions: input.dimensions,
          geometryFingerprint: createGeometryFingerprint(input),
        });
        return;
      }

      await Promise.all(
        storageKeys.map(storageKey =>
          putToStore(db, {
            version: 1,
            storageKey,
            segmentationId: input.segmentationId,
            segmentationVolumeId: input.segmentationVolumeId,
            segmentIndex: input.segmentIndex,
            dimensions: input.dimensions,
            geometryFingerprint: createGeometryFingerprint(input),
            voxelIndices,
            voxelCount: voxelIndices.length,
            updatedAt: Date.now(),
          })
        )
      );
    } catch {
      // IndexedDB 不可用、容量不足或事务失败时忽略，分割主流程仍以内存中的 Segment 1 为准。
    }
  }

  private async deleteSegmentMaskRecordsForGeometry(
    db: IDBDatabase,
    storageKeys: string[],
    {
      segmentIndex,
      dimensions,
      geometryFingerprint,
    }: {
      segmentIndex: number;
      dimensions: [number, number, number];
      geometryFingerprint: string;
    }
  ): Promise<boolean> {
    // [2026-08-27 功能] 本地存储管理 UI：按稳定 key 和几何指纹清理同一病例的所有本地 mask，避免旧 key 仍可恢复
    let didDelete = false;

    for (const storageKey of storageKeys) {
      const record = await getFromStore<PersistedSegmentMask>(db, storageKey);

      if (
        this.isValidSegmentMaskRecord(record, {
          segmentIndex,
          dimensions,
          geometryFingerprint,
        })
      ) {
        await deleteFromStore(db, storageKey);
        didDelete = true;
      }
    }

    const records = await getAllFromStore<PersistedSegmentMask>(db);

    for (const record of records) {
      if (
        record?.storageKey &&
        !storageKeys.includes(record.storageKey) &&
        this.isValidSegmentMaskRecord(record, {
          segmentIndex,
          dimensions,
          geometryFingerprint,
        })
      ) {
        await deleteFromStore(db, record.storageKey);
        didDelete = true;
      }
    }

    return didDelete;
  }

  private async findSegmentMaskForReferenceVolume({
    referenceVolume,
    segmentIndex,
    dimensions,
  }: ReferenceVolumeMaskContext): Promise<PersistedSegmentMask | null> {
    // [2026-08-27 功能] 本地存储管理 UI：优先按稳定 key 查找，刷新后 key 变化时再按几何指纹兜底匹配
    const db = await this.getDatabase();

    if (!db) {
      return null;
    }

    const storageKeys = this.createStorageKeysFromReferenceVolume(referenceVolume, segmentIndex);
    const geometryFingerprint = createGeometryFingerprint({ referenceVolume, dimensions });

    try {
      for (const storageKey of storageKeys) {
        const record = await getFromStore<PersistedSegmentMask>(db, storageKey);

        if (
          this.isValidSegmentMaskRecord(record, {
            segmentIndex,
            dimensions,
            geometryFingerprint,
          })
        ) {
          return record;
        }
      }

      const records = await getAllFromStore<PersistedSegmentMask>(db);

      return (
        records.find(record =>
          this.isValidSegmentMaskRecord(record, {
            segmentIndex,
            dimensions,
            geometryFingerprint,
          })
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private isValidSegmentMaskRecord(
    record: PersistedSegmentMask | null,
    {
      segmentIndex,
      dimensions,
      geometryFingerprint,
    }: {
      segmentIndex: number;
      dimensions: [number, number, number];
      geometryFingerprint: string;
    }
  ): record is PersistedSegmentMask {
    return (
      !!record &&
      record.version === 1 &&
      record.segmentIndex === segmentIndex &&
      areDimensionsEqual(record.dimensions, dimensions) &&
      !!record.geometryFingerprint &&
      record.geometryFingerprint === geometryFingerprint &&
      !!record.voxelIndices?.length
    );
  }

  private clearScheduledSaves(storageKeys: string[]): void {
    storageKeys.forEach(storageKey => {
      const timeout = this.saveTimeoutByKey.get(storageKey);

      if (!timeout) {
        return;
      }

      clearTimeout(timeout);
      this.saveTimeoutByKey.delete(storageKey);
    });
  }

  private async getDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    if (!this.dbPromise) {
      this.dbPromise = new Promise(resolve => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;

          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'storageKey' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
    }

    return this.dbPromise;
  }

  private createStorageKeys(context: SegmentMaskContext): string[] {
    // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：保存多个稳定 key，提高刷新后新 segmentationId 下的恢复命中率
    const referenceVolume = getReferenceVolume(context.segmentationVolumeId);
    const storageKeys = this.createStorageKeysFromReferenceVolume(
      referenceVolume,
      context.segmentIndex
    );

    storageKeys.push(
      `volume:${context.segmentationVolumeId}|segmentation:${context.segmentationId}|segment:${context.segmentIndex}`
    );

    return Array.from(new Set(storageKeys));
  }

  private createStorageKeysFromReferenceVolume(
    referenceVolume: any,
    segmentIndex: number
  ): string[] {
    const metadata = referenceVolume?.metadata ?? {};
    const studyInstanceUID = metadata.StudyInstanceUID ?? metadata.studyInstanceUID;
    const seriesInstanceUID = metadata.SeriesInstanceUID ?? metadata.seriesInstanceUID;
    const referenceVolumeId = referenceVolume?.volumeId;
    const firstImageId = referenceVolume?.imageIds?.[0];
    const storageKeys = [];

    if (studyInstanceUID && seriesInstanceUID) {
      storageKeys.push(
        `study:${studyInstanceUID}|series:${seriesInstanceUID}|segment:${segmentIndex}`
      );
    }

    if (referenceVolumeId) {
      storageKeys.push(`referenceVolume:${referenceVolumeId}|segment:${segmentIndex}`);
    }

    if (firstImageId) {
      storageKeys.push(`firstImage:${firstImageId}|segment:${segmentIndex}`);
    }

    return Array.from(new Set(storageKeys));
  }
}

function collectSegmentVoxelIndices(
  scalarData: NumericArray,
  segmentIndex: number,
  maxVoxelCount: number
): Uint32Array | null {
  const indices: number[] = [];

  for (let voxelIndex = 0; voxelIndex < scalarData.length; voxelIndex++) {
    if (scalarData[voxelIndex] === segmentIndex) {
      indices.push(voxelIndex);

      if (indices.length > maxVoxelCount) {
        return null;
      }
    }
  }

  return new Uint32Array(indices);
}

function areDimensionsEqual(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function createGeometryFingerprint(context: {
  segmentationVolumeId?: string;
  segmentationVolume?: any;
  referenceVolume?: any;
  dimensions: [number, number, number];
}): string {
  // [2026-08-26 功能] IndexedDB 稀疏保存/恢复 Segment 1 mask：用几何指纹校验 origin/spacing/direction，避免 mask 恢复到错误空间位置
  const referenceVolume =
    context.referenceVolume ??
    (context.segmentationVolumeId ? getReferenceVolume(context.segmentationVolumeId) : null);
  const geometrySource = referenceVolume ?? context.segmentationVolume ?? {};

  return [
    `dimensions:${context.dimensions.join(',')}`,
    `origin:${formatGeometryArray(geometrySource.origin)}`,
    `spacing:${formatGeometryArray(geometrySource.spacing)}`,
    `direction:${formatGeometryArray(geometrySource.direction)}`,
  ].join('|');
}

function formatGeometryArray(values?: ArrayLike<number> | null): string {
  if (!values) {
    return '';
  }

  return Array.from(values)
    .map(value => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6) : ''))
    .join(',');
}

function getReferenceVolume(segmentationVolumeId: string) {
  try {
    return csTools.utilities.segmentation.getReferenceVolumeForSegmentationVolume(
      segmentationVolumeId
    );
  } catch {
    return null;
  }
}

function getFromStore<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise(resolve => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);

    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => resolve(null);
  });
}

function getAllFromStore<T>(db: IDBDatabase): Promise<T[]> {
  return new Promise(resolve => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => resolve((request.result as T[]) ?? []);
    request.onerror = () => resolve([]);
  });
}

function putToStore(db: IDBDatabase, record: PersistedSegmentMask): Promise<void> {
  return new Promise(resolve => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const request = transaction.objectStore(STORE_NAME).put(record);

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

function deleteFromStore(db: IDBDatabase, key: string): Promise<void> {
  return new Promise(resolve => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const request = transaction.objectStore(STORE_NAME).delete(key);

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

const tmtvSegmentMaskStorageService = new TMTVSegmentMaskStorageService();

export default tmtvSegmentMaskStorageService;
