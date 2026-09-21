# TMTV GPU 兼容性记录

更新日期：2026-09-20

## 结论

在已测试的 Windows Intel 集成显卡上，Chrome/ANGLE 默认 D3D11 后端会产生明显高于体数据原始大小的 GPU 进程私有内存。切换到 D3D11on12 后，两台测试机的四视口工作流均显著降低内存占用。

生产环境当前推荐使用：

```text
--use-gl=angle --use-angle=d3d11on12
```

这些参数必须加在 Chrome 启动命令中，不能添加到检查页面 URL 中。

## 生产启动脚本

仓库内启动器位于 `scripts/start-tmtv-production.cmd`。部署前，将脚本中的默认地址替换为真实生产地址：

```bat
set "TMTV_URL=https://viewer.example.com/"
```

也可以不修改脚本，通过第一个参数传入地址：

```bat
start-tmtv-production.cmd "https://viewer.example.com/"
```

脚本会自动查找系统级或当前用户安装的 Chrome，并使用 `%LOCALAPPDATA%\OHIF-TMTV\ChromeProfile` 作为独立配置目录。该目录不要在工作站之间复制，也不要与普通 Chrome 共用。

如果 Chrome 安装在非标准目录，需要在脚本的 Chrome 探测区域增加实际路径。脚本找不到 Chrome、无法创建配置目录或没有配置生产地址时会终止，不会回退到默认 D3D11。

## 已验证设备

| 编号 | GPU | 驱动版本 | Chrome/ANGLE 后端 | GPU 进程 Private footprint | 结果 | 备注 |
| --- | --- | --- | --- | ---: | --- | --- |
| A-1 | Intel Iris Xe Graphics (`0x9A49`) | `32.0.101.7085` | D3D11 | 约 8,146.5 MiB | 不通过 | 四视口可能黑屏，存在 WebGL context lost 风险 |
| A-2 | Intel Iris Xe Graphics (`0x9A49`) | `32.0.101.7085` | D3D11on12 | 约 790.7 MiB；实际观察约 0.5-2 GiB | 通过 | 硬件加速正常，四视口可用 |
| B-1 | Intel UHD Graphics 620 (`0x5917`) | `22.20.16.4749` | D3D11 | 约 2,036.8 MiB | 有风险 | 未出现 8 GiB 峰值，但驱动层私有内存仍偏高 |
| B-2 | Intel UHD Graphics 620 (`0x5917`) | `22.20.16.4749` | D3D11on12 | 约 563.8 MiB | 通过 | Chrome 总 Private footprint 约 1,237.8 MiB |

## 测试数据基线

测试使用同一组 CT/PET 检查：

| 数据 | 尺寸 | WebGL 数据格式 | 估算上传量 |
| --- | --- | --- | ---: |
| CT | `512 x 512 x 396` | `R16_SNORM / SHORT` | 约 198 MiB |
| PET | `200 x 200 x 264` | `R32F / FLOAT` | 约 39.6 MiB |

应用侧探针记录为两份 3D 纹理各分配一次，没有发现同一体数据被重复分配或重复上传。

## 新设备验收步骤

1. 使用生产专用启动脚本打开系统。
2. 在 `chrome://gpu` 中确认 `Display type` 为 `ANGLE_D3D11on12`。
3. 确认 `GL_RENDERER` 同时包含实际 Intel GPU 名称和 `Direct3D11on12`。
4. 如果出现 `WARP` 或 `Microsoft Basic Render Driver`，判定为软件渲染，不通过生产验收。
5. 加载同一组 CT、PET和融合四视口，验证滚动、窗宽窗位、十字线、融合及分割操作。
6. 连续进入和退出检查至少 5 次，每次返回查询页后等待 30 秒。
7. 记录 GPU 进程内存；若每轮持续阶梯式增长、出现黑屏或 WebGL context lost，判定为不通过。

## 兼容性记录模板

| 测试日期 | 设备型号 | Windows版本 | Chrome版本 | GPU | 驱动版本 | 后端 | 初始内存 | 四视口峰值 | 退出后内存 | 5轮后内存 | 结果 | 测试人 |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
|  |  |  |  |  |  | D3D11on12 |  |  |  |  |  |  |

## 运维注意事项

- Chrome 更新或显卡驱动升级后，应在代表性设备上重新执行验收。
- 优先安装设备厂商验证过的显卡驱动；更新后仍需保留 D3D11on12 对照测试。
- 不使用 WARP 作为生产方案，因为它属于 CPU 软件渲染。
- 应保留独立 Chrome 用户数据目录，避免普通 Chrome 进程先启动后吞掉生产启动参数。
- 如果系统由 HIS/PACS 外部链接打开，应让外部系统调用专用启动器，而不是直接调用默认浏览器。
