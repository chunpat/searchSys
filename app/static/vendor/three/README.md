# Three.js 本地依赖

- 版本：`three@0.180.0`（模块中的 `REVISION` 为 `180`）。
- 来源：npm 包 `three` 的 `build/three.module.js`、`build/three.core.js`、`examples/jsm/controls/OrbitControls.js` 和 `examples/jsm/environments/RoomEnvironment.js`。
- 许可证：MIT，完整文本保留在本目录的 `LICENSE`。
- 本地改动：两个附加模块中的 `from 'three'` 改为 `from './three.module.js'`，以支持浏览器直接加载，不依赖 CDN 或 import map。

这些文件作为运行依赖纳入 Git。升级时应成套替换同一版本的模块、保留许可证，并重新检查 3D 模型、尺寸标注、贴图和鼠标操作。
