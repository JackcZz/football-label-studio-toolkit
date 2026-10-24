# migu-labeling-toolkit

Label Studio 足球赛多机位机器标注的 **质检 + AI 代写** 工具集。

> 沉淀自 YOUR_PROJECT 项目（11 机位足球赛，每机位 7500 帧）。机器预测（凉白开）已预标球员框和球衣号码，但存在漏检、多检、号码错、串号等问题。本工具集用 v8b 引擎逐帧链式修正，实现「AI 接管大部分机械活、人只判异常与切换点」。

---

## 目录结构

```
migu-labeling-toolkit/
├── README.md                  # 本文件
├── 文件说明.md                 # 每个文件的用途标注（先读这个）
├── .gitignore
├── SOP/                       # 标准作业流程
│   └── 标注代写入SOP.md         # ★ 核心方法论，做新机位先读它
├── 引擎/                       # 核心引擎
│   └── correct_v8_gate.py      # ★ v8b 引擎模板（逐帧链式修正）
├── 程序/                       # 工具脚本
│   ├── cdp.js                  # CDP 通道（浏览器执行 JS / 取 cookie）
│   ├── fetch_tasks.py          # 拉项目任务列表
│   ├── fetch_all.py            # 拉多机位任务
│   ├── fetch_rest.py           # 补拉剩余机位
│   ├── analyze_cam.py          # 分析单机位数据
│   ├── build_console.py        # 审查总控台
│   ├── export_annotations.py   # 导出标注
│   ├── make_animation.py       # 制作帧动画
│   ├── make_workstation.py     # 制作工作站
│   ├── mark_server.py          # marks 本地服务
│   └── screenshot.js           # CDP 截图
├── 参考文档/                   # 分析报告（方法与结果示例）
│   ├── cam4/                   # cam4 的复查/串号排查报告
│   └── cam3/                   # cam3 的分析/分镜/进度报告
├── 工具/                       # 辅助工具
│   ├── ls-frame-inspector/     # Chrome 插件（点帧看信息+前后帧对照）
│   └── start-chrome-debug.command  # Chrome 调试模式启动器
└── 代写入记录示例/             # 代写入记录格式示例
    └── cam3-001_....md
```

---

## 快速开始

1. **读 `文件说明.md`** 了解每个文件。
2. **读 `SOP/标注代写入SOP.md`** 掌握整套方法论。
3. 准备环境：Chrome 调试模式（9222 端口）、Python 3.13、Label Studio 登录态。
4. 确认新机位的 `task_id` 偏移（每个机位不同，见 SOP 第三节）。
5. 按 SOP 的 10 步流程跑一批：拉数据 → 查基准口径 → 查目标状态 → 改引擎 → 跑 → 核验 → 写入 → 验证 → 记记录。

---

## 核心引擎（v8b）

`引擎/correct_v8_gate.py` 是核心。它做一件事：**以「上一帧已修正结果」为基准，修正当前帧的框和号码**。

规则要点：
- 两阶段匹配：同号+同标签绝对优先 → 全局贪心按距离最近认领
- `CLAIM_TOL = 2.0`：身份框位移超门槛 = 误识别框 → 删 + 补框落到上一帧位置
- 删 unknown / 无号 / 上一帧无对应的框 / 重复框
- 补号：无号框 → 上一帧同位置框的号码
- 补框：上一帧有本帧缺 → 贴上一帧位置

改引擎只需改 4 处（RAW 路径、基准帧、区间、src 规则），见 SOP 第五节。

---

## 关键口径（每个机位先确认）

| 项 | 说明 |
|---|---|
| task_id 偏移 | **各机位不同**（cam4=+33367，cam3=+3367），拉任意 task 看 `data.frame` vs `id` |
| 坐标 | Label Studio 百分比 0–100，帧间匹配阈值 6 个百分点 |
| 号码存储 | `textarea`(text) 和 `number` 两种类型，解析都要匹配 |

---

## ⚠️ 安全提醒（已脱敏）

本仓库所有敏感信息已替换为占位符，**用之前把占位符改回你的实际值**：

| 占位符 | 原含义 | 替换回 |
|---|---|---|
| `YOUR_LABEL_STUDIO_HOST` | 完整地址（IP:端口） | `http://<你的IP>:<端口>` |
| `YOUR_HOST` | 纯 IP | `<你的IP>` |
| `YOUR_ACCOUNT_ID` | 账号（代写/审核账号） | `<你的账号>` |
| `YOUR_DATA_PATH` | 图片数据路径前缀 | `/data/local-files/` 等 |
| `YOUR_PROJECT` | 项目代号 | `migu_1014` 等 |
| `YOUR_DATA_DIR` | 数据目录 | `migu_data` 等 |

- **Chrome 插件**（`工具/ls-frame-inspector/`）的 `manifest.json`、`bg.js` 里的 `YOUR_LABEL_STUDIO_HOST` 必须改回真实域名，否则插件无法匹配目标站。
- 不要把 `cookie_header.txt`、`sessionid` 等凭证上传（`.gitignore` 已排除）。
- 本工具集的代写走 Label Studio 的 POST/PATCH 接口，务必在操作前确认目标帧的标注状态，避免重复标注。

---

## License

内部工具，仅供本人/团队质检使用。
