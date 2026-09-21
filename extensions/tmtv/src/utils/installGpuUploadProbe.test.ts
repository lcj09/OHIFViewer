import installGpuUploadProbe from './installGpuUploadProbe';

class FakeWebGL2RenderingContext {
  TEXTURE_3D = 0x806f;

  bindTexture(..._args: unknown[]) {}
  texStorage3D(..._args: unknown[]) {}
  texImage3D(..._args: unknown[]) {}
  texSubImage3D(..._args: unknown[]) {}
}

describe('installGpuUploadProbe', () => {
  const originalWebGL2 = Object.getOwnPropertyDescriptor(globalThis, 'WebGL2RenderingContext');
  const originalUrl = window.location.pathname + window.location.search;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'WebGL2RenderingContext', {
      configurable: true,
      value: FakeWebGL2RenderingContext,
    });
  });

  afterEach(() => {
    window.history.replaceState({}, '', originalUrl);
    if (originalWebGL2) {
      Object.defineProperty(globalThis, 'WebGL2RenderingContext', originalWebGL2);
    } else {
      delete (globalThis as any).WebGL2RenderingContext;
    }
  });

  it('does not modify WebGL outside a TMTV memory probe', () => {
    window.history.replaceState({}, '', '/tmtv');
    const original = FakeWebGL2RenderingContext.prototype.texSubImage3D;

    installGpuUploadProbe()();

    expect(FakeWebGL2RenderingContext.prototype.texSubImage3D).toBe(original);
    expect((globalThis as any).__tmtvGpuUploadStats).toBeUndefined();
  });

  it('leaves rendering methods intact when the browser rejects instrumentation', () => {
    window.history.replaceState({}, '', '/tmtv?tmtvMemoryProbe=ctpt');
    const original = Object.getOwnPropertyDescriptor(
      FakeWebGL2RenderingContext.prototype,
      'texStorage3D'
    )!;
    Object.defineProperty(FakeWebGL2RenderingContext.prototype, 'texStorage3D', {
      ...original,
      writable: false,
    });
    const originalBind = FakeWebGL2RenderingContext.prototype.bindTexture;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => installGpuUploadProbe()()).not.toThrow();
      expect(FakeWebGL2RenderingContext.prototype.bindTexture).toBe(originalBind);
      expect((globalThis as any).__tmtvGpuUploadStats).toBeUndefined();
    } finally {
      Object.defineProperty(FakeWebGL2RenderingContext.prototype, 'texStorage3D', original);
      warn.mockRestore();
    }
  });

  it('counts 3D texture allocations and uploads, then restores native methods', () => {
    window.history.replaceState({}, '', '/tmtv?tmtvMemoryProbe=ctpt');
    const originalBind = FakeWebGL2RenderingContext.prototype.bindTexture;
    const originalUpload = FakeWebGL2RenderingContext.prototype.texSubImage3D;
    const cleanup = installGpuUploadProbe();
    const gl = new FakeWebGL2RenderingContext();

    try {
      gl.bindTexture(gl.TEXTURE_3D, {});
      gl.texStorage3D(gl.TEXTURE_3D, 1, 0x822d, 8, 8, 4);
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        0,
        8,
        8,
        1,
        0x1903,
        0x1406,
        new Float32Array(64)
      );

      const stats = (globalThis as any).__tmtvGpuUploadStats;
      expect(stats.textures).toEqual([
        expect.objectContaining({
          width: 8,
          height: 8,
          depth: 4,
          internalFormat: 0x822d,
          allocationCalls: 1,
          uploadCalls: 1,
        }),
      ]);
      for (let i = 0; i < 3; i++) {
        gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, i, 8, 8, 1, 0x1903, 0x1401, new Uint8Array(8000));
      }
      expect(stats.textures[0].uploadedMB).toBe(0.02);
      expect(JSON.stringify(stats)).not.toContain('TEXTURE_3D');
    } finally {
      cleanup();
    }

    expect(FakeWebGL2RenderingContext.prototype.bindTexture).toBe(originalBind);
    expect(FakeWebGL2RenderingContext.prototype.texSubImage3D).toBe(originalUpload);
    expect((globalThis as any).__tmtvGpuUploadStats).toBeUndefined();
  });
});
