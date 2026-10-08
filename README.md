# NEON BREACH

一个完全离线运行的 3D 第一人称射击游戏。基于 **three.js** + **原生 ES Modules**，
**没有构建步骤**，**没有任何外部素材下载** —— 所有贴图、音效、关卡、武器和敌人
模型都是运行时程序化生成的。

> A fully offline 3D first-person shooter. Every texture, sound, level, weapon
> and creature is generated procedurally at runtime. No bundler, no asset
> downloads, no build step.

---

## 快速开始

### 方式一：双击启动（推荐）

| 文件 | 说明 |
| --- | --- |
| **`start.bat`** | Windows 双击即可。自动检查 Node、按需 `npm install`、挑选空闲端口、启动服务器并打开浏览器 |
| **`start.ps1`** | PowerShell 版本，支持参数 |

```powershell
.\start.ps1                    # 启动并打开浏览器
.\start.ps1 -Port 8080         # 指定端口
.\start.ps1 -NoOpen            # 不自动打开浏览器
.\start.ps1 -Vendor            # 从 .\threejs 提供 three.js（不依赖 node_modules）
```

> 若 PowerShell 提示「禁止运行脚本」，先用 `start.bat`，或在当前窗口执行一次
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`。

### 方式二：npm

```bash
npm install       # 只安装 three.js（必需）
npm start         # 启动并自动打开浏览器
```

其他命令：

```bash
npm run start:noopen    # 启动但不打开浏览器
npm run start:vendor    # 从 threejs/ 提供 three.js
npm run dev             # 只启动静态服务器（不自动开浏览器）
npm run vendor          # 把 addons 补齐进 threejs/
```

启动器会自动完成：Node 版本检查 → 依赖检查（缺失则执行 `npm install`，并把
npm 缓存指向工作区内的 `.npm-cache` 以避免权限问题）→ 端口探测（5180 起，被占用
则顺延）→ 启动服务器 → 打开浏览器。

然后打开 **http://127.0.0.1:5180/** 并点击画面进入指针锁定模式。

> 必须通过 HTTP 访问：项目使用原生 ES Modules，浏览器不允许从 `file://` 加载模块。
> 因此不能直接双击 `index.html`。

### 无需 node_modules 运行（可选）

仓库里的 `threejs/` 目录是一份自包含的 three.js r180。执行一次：

```bash
npm run vendor        # 把游戏用到的 addons 复制进 threejs/
npm run start:vendor  # 从 threejs/ 提供 three.js，不再依赖 node_modules
```

---

## 操作

| 按键 | 功能 |
| --- | --- |
| `W A S D` | 移动 |
| 鼠标 | 瞄准 |
| 左键 | 射击 |
| 右键 | 瞄准镜 ADS（降低扩散、放大视野） |
| `R` | 换弹 |
| `1` – `7` | 切换武器 |
| `Q` | 投掷手雷 |
| `F` | 近战 / 处决 |
| `Shift` | 疾跑（双击冲刺） |
| `Ctrl` / `C` | 蹲下 |
| `Space` | 跳跃 |
| `Tab` | 战术地图开关 |
| `Esc` | 暂停 |

**战斗要点**：爆头造成约 2.4–3 倍伤害；连续击杀叠加连击倍率（最高 x5，
提高得分）；护甲优先吸收 65% 伤害；每波之间进入军械库购买武器与永久升级。

---

## 内容

**地图** — 一座轨道研究站，10 个区域：调车场、服务器大厅、反应堆尖塔、
机库、中庭（含二层天桥）、地图室、维护隧道、金库、实验区、观测台。
关卡由 ASCII 瓦片图生成：2 210 个碰撞体，几何体按材质合并为 **48 个网格 /
约 10 600 个三角形**。

**敌人** — 8 种单位，各有独立行为：

| 单位 | 行为 |
| --- | --- |
| 爬行体 Crawler | 群体冲锋近战 |
| 喷酸体 Spitter | 抛射酸液弹，逼迫走位 |
| 巡飞机 Drone | 悬浮点射 |
| 重压者 Brute | 蓄力冲锋撞击 |
| 潜猎者 Stalker | 短距瞬移突袭 |
| 护盾兵 Bulwark | 正面装甲减伤 65% |
| 典狱长 Warden | BOSS：双联重炮 + 震荡踏击 |
| 过载核心 Overloader | 最终 BOSS：弹幕环 + 召唤 |

**武器** — 7 把，弹道与手感各不相同：脉冲步枪、黄蜂冲锋枪、破门霰弹枪、
审判者马格南、电弧轨道炮（穿透 6 个目标）、螺旋等离子（范围爆炸）、
火神加特林（预热后倾泻）。另有 15 项永久升级与消耗品补给。

**玩法** — 12 波次递增的生存战，波间军械库整备，供应空投，连击系统，
生命维持系统的“背水一战”，最终 BOSS 战后可选继续无尽模式。

---

## 技术要点

| 系统 | 实现 |
| --- | --- |
| 贴图 | 12 套程序化 PBR 材质：512² 反照率 + 由高度图推导的法线/粗糙度/环境光遮蔽，全部无缝平铺 |
| 光照 | 程序化天空穹顶（渐变、星空、月亮、云带）+ PMREM 环境探针，30 盏点光源 |
| 后期 | EffectComposer → UnrealBloom → OutputPass → FXAA → 自定义调色（暗角、色差、胶片颗粒、扫描线、受伤/治疗/慢动作反馈） |
| 音频 | 100% WebAudio 合成：枪声、弹壳、脚步（按地面材质区分）、异形咆哮、环境氛围音乐；全部做 3D 声像定位 |
| AI | 网格 A* + 弦拉平滑 +碰撞世界校验，视野判定，仇恨迟滞，冲锋/瞬移/环射等特殊行为 |
| 物理 | 空间哈希 AABB 世界：逐轴胶囊滑动、台阶攀爬、射线检测（穿甲弹道、视线、贴花投射） |
| 特效 | 着色器点精灵粒子池（4000）、贴花环缓冲（220）、曳光弹、冲击波、浮动伤害数字 |
| HUD | 纯 DOM 覆盖层：霓虹描边、连击条、击杀信息流、方向受击指示、实时小地图 |

### 项目结构

```
index.html            入口 + import map
start.bat             Windows 双击启动
start.ps1             PowerShell 启动
threejs/             自包含 three.js r180（+ 由 npm run vendor 补齐的 addons）
src/
  main.js             启动流程与主循环
  level.js            关卡：ASCII 地图 → 几何体 / 碰撞体 / 导航网格 / 刷怪点
  core/     physics.js  input.js  env.js
  gfx/      textures.js  sky.js  post.js  fx.js  noise.js
  gameplay/ weapons.js  player.js  director.js
  entities/ enemy.js  projectiles.js  pickups.js
  ai/       pathfind.js
  audio/    audio.js
  ui/       hud.js  ui.js  style.css
tools/
  launch.mjs          启动器（环境检查 / 装依赖 / 选端口 / 开浏览器）
  serve.mjs           静态服务器（--vendor 可切换到 threejs/）
  vendor.mjs          把 three.js addons 复制进 threejs/
  verify.mjs          静态与系统级检查（105 项）
  simulate.mjs        真实玩法模拟 + 战斗杀伤力（46 项）
  probe-reach.mjs     敌人寻路可达性
  audit-shaders.mjs   GLSL 静态审计（33 项）
  audit-ui.mjs        DOM 接线审计
  domsim.mjs          Node 下的最小 DOM/Canvas 垫片
```

---

## 离线验证

本项目无法在受限沙箱内启动浏览器（Chrome 自身的 mojo IPC 需要命名管道），
因此所有验证都在 Node 中完成 —— 通过一个最小的 DOM/Canvas 垫片直接运行真实
游戏代码。

```bash
npm run verify          # 全部五项
npm run verify:static   # 105 项：模块图、贴图工厂、关卡、碰撞、寻路、武器表
npm run verify:sim      #  46 项：5 分钟真实玩法模拟 + 战斗杀伤力测试
npm run verify:nav      # 从每个区域出发，敌人能否走到玩家身边
npm run verify:shaders  #  33 项：手写 GLSL 的括号平衡、uniform/varying 接线
npm run verify:ui       # DOM id 与样式类接线检查
```

验证覆盖的关键不变量：

- 关卡**全部可走瓦片互相连通**（`level.validate()` 在构建时强制检查，不通过直接抛错）
- 任意两个区域之间都存在 A* 路径，且路径每一段都不穿过实体道具
- 敌人从**每个区域**出发都能抵达玩家 —— 出生距离内 13/13，跨全图 23/23
- 4 分钟模拟中无运行时异常、无 NaN 变换、敌人不会卡进几何体或掉出地图
- 每把武器都能击杀目标；爆头伤害显著高于躯干（88.9 对 24.5）；手雷能范围杀伤
- 18 000 帧的模拟对应约 1–4 ms/帧的纯逻辑开销（无 GPU）

### 未经浏览器验证的部分

上述测试无法覆盖 GPU：**着色器编译、实际渲染画面、真实帧率、音频输出**尚未在
真实浏览器中确认（本环境无法启动 Chrome —— 其 mojo IPC 依赖命名管道，被沙箱
拒绝）。GLSL 已通过静态审计（括号平衡、uniform/varying 接线、函数名），但首次
运行时仍建议打开开发者控制台查看是否有编译错误。

---

## 已知限制

- 需要支持 WebGL2 的浏览器（Chrome / Edge / Firefox 现代版本）。
- 未在真实 GPU 上做过帧率实测；渲染管线包含泛光与 FXAA，低端设备建议在
  设置中把画质切到「低」。
- 阴影贴图默认关闭（依赖贴图内烘焙的 AO 与动态点光源），这是为无 GPU
  验证环境所做的取舍。

## 许可

代码为原创。three.js 由其 MIT 许可覆盖（见 `node_modules/three/LICENSE`）。
