type TextureUploadRecord = {
  textureId: number;
  width: number;
  height: number;
  depth: number;
  internalFormat: number | null;
  format: number | null;
  dataType: number | null;
  allocationCalls: number;
  uploadCalls: number;
  uploadedMB: number;
};

type GpuUploadStats = {
  generatedAt: string;
  textures: TextureUploadRecord[];
};

const statsTarget = globalThis as typeof globalThis & {
  __tmtvGpuUploadStats?: GpuUploadStats;
};

const methodNames = ['bindTexture', 'texStorage3D', 'texImage3D', 'texSubImage3D'] as const;

/** 2026-09-18 功能说明：仅在 TMTV 内存诊断时统计 WebGL2 体纹理分配和上传，退出时恢复原型方法。 */
export default function installGpuUploadProbe(): () => void {
  if (
    typeof window === 'undefined' ||
    typeof WebGL2RenderingContext === 'undefined' ||
    !window.location.pathname.startsWith('/tmtv') ||
    !new URLSearchParams(window.location.search).has('tmtvMemoryProbe')
  ) {
    return () => {};
  }

  const prototype = WebGL2RenderingContext.prototype as unknown as Record<string, Function>;
  const originals = Object.fromEntries(methodNames.map(name => [name, prototype[name]])) as Record<
    (typeof methodNames)[number],
    Function
  >;
  if (methodNames.some(name => typeof originals[name] !== 'function')) {
    return () => {};
  }

  const ownMethods = new Set(
    methodNames.filter(name => Object.prototype.hasOwnProperty.call(prototype, name))
  );
  const stats: GpuUploadStats = { generatedAt: new Date().toISOString(), textures: [] };
  const textureIds = new WeakMap<object, number>();
  const boundTextureIds = new WeakMap<object, number>();
  const records = new Map<number, TextureUploadRecord>();
  const uploadedBytesByTextureId = new Map<number, number>();
  let nextTextureId = 1;
  let active = true;

  const getRecord = (context: WebGL2RenderingContext): TextureUploadRecord | undefined => {
    const textureId = boundTextureIds.get(context);
    if (!textureId) return;
    let record = records.get(textureId);
    if (!record) {
      record = {
        textureId,
        width: 0,
        height: 0,
        depth: 0,
        internalFormat: null,
        format: null,
        dataType: null,
        allocationCalls: 0,
        uploadCalls: 0,
        uploadedMB: 0,
      };
      records.set(textureId, record);
      stats.textures.push(record);
    }
    return record;
  };

  const addUpload = (record: TextureUploadRecord, pixels: unknown) => {
    record.uploadCalls++;
    if (ArrayBuffer.isView(pixels)) {
      const uploadedBytes = (uploadedBytesByTextureId.get(record.textureId) ?? 0) + pixels.byteLength;
      uploadedBytesByTextureId.set(record.textureId, uploadedBytes);
      record.uploadedMB = Number((uploadedBytes / 1048576).toFixed(2));
    }
  };

  const wrappers: Record<(typeof methodNames)[number], Function> = {
    bindTexture: function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const result = originals.bindTexture.apply(this, args);
      if (active && args[0] === this.TEXTURE_3D) {
        const texture = args[1];
        if (texture && typeof texture === 'object') {
          let id = textureIds.get(texture);
          if (!id) {
            id = nextTextureId++;
            textureIds.set(texture, id);
          }
          boundTextureIds.set(this, id);
        } else {
          boundTextureIds.delete(this);
        }
      }
      return result;
    },
    texStorage3D: function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const result = originals.texStorage3D.apply(this, args);
      if (active && args[0] === this.TEXTURE_3D) {
        const record = getRecord(this);
        if (record) {
          record.internalFormat = Number(args[2]);
          record.width = Number(args[3]);
          record.height = Number(args[4]);
          record.depth = Number(args[5]);
          record.allocationCalls++;
        }
      }
      return result;
    },
    texImage3D: function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const result = originals.texImage3D.apply(this, args);
      if (active && args[0] === this.TEXTURE_3D) {
        const record = getRecord(this);
        if (record) {
          record.internalFormat = Number(args[2]);
          record.width = Number(args[3]);
          record.height = Number(args[4]);
          record.depth = Number(args[5]);
          record.format = Number(args[7]);
          record.dataType = Number(args[8]);
          record.allocationCalls++;
          if (args[9] != null) addUpload(record, args[9]);
        }
      }
      return result;
    },
    texSubImage3D: function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const result = originals.texSubImage3D.apply(this, args);
      if (active && args[0] === this.TEXTURE_3D) {
        const record = getRecord(this);
        if (record) {
          record.format = Number(args[8]);
          record.dataType = Number(args[9]);
          addUpload(record, args[10]);
        }
      }
      return result;
    },
  };

  const restore = () => {
    active = false;
    methodNames.forEach(name => {
      if (prototype[name] !== wrappers[name]) return;
      try {
        if (ownMethods.has(name)) prototype[name] = originals[name];
        else delete prototype[name];
      } catch { /* browser may lock a native method during teardown */ }
    });
    if (statsTarget.__tmtvGpuUploadStats === stats) {
      delete statsTarget.__tmtvGpuUploadStats;
    }
  };

  try {
    methodNames.forEach(name => {
      prototype[name] = wrappers[name];
      if (prototype[name] !== wrappers[name]) throw new Error(`${name} is read-only`);
    });
    statsTarget.__tmtvGpuUploadStats = stats;
  } catch (error) {
    restore();
    console.warn('[TMTV] WebGL upload probe unavailable', error);
  }

  return restore;
}
