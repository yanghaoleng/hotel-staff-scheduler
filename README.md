# 祥宇·智能排班表

一个面向酒店团队的智能排班工具：把复杂的排班规则交给 AI 理解，把最终排班交给本地规则引擎校验，再用轻快、直觉的交互完成调整。

它的核心亮点不是“让 AI 随便生成一张表”，而是让 AI 成为排班助手：你可以直接说“下周每天安排 1 个早班、1 个晚班，尽量均衡每个人的工作量”，系统会解析条件、结合现有人员和固定规则生成结果；所有新增班次会顺滑地落入日历，仍然可以像普通日历一样拖拽、补录和撤销。

## 亮点

- **AI 自动排班**：支持自然语言描述排班目标、日期范围、班次和约束。
- **AI + 规则引擎双重保障**：DeepSeek 负责理解需求，本地调度引擎负责生成与校验，避免少排、漏排或违反固定规则。
- **丝滑的日历交互**：拖拽换班、点击加号快速补人、框选批量清空、撤销恢复，动效反馈清晰但不打扰操作。
- **语音输入**：支持通过豆包语音转文字输入排班要求，适合边看表边口述调整。
- **多 Sheet 协作**：不同团队或月份可以独立管理；无需登录，打开即可编辑和同步。
- **移动端友好**：月历、吸顶日期和快捷操作针对手机屏幕做了适配，375px 宽度也能完整查看一周。
- **可控、可追溯**：每次 AI 批量修改都可以一键撤销；复制功能可直接导出为适合 Excel 粘贴的表格。
- **轻量部署**：Flask + SQLite 后端，Vite + React 前端，适合单机或小团队服务器部署。

## 工作方式

```text
自然语言 / 语音输入
          ↓
AI 解析排班条件
          ↓
本地规则引擎生成并校验班次
          ↓
日历动画展示 → 拖拽微调 / 撤销 / 复制到 Excel
```

AI 只负责把人话转换成结构化的排班条件，真正的班次生成和约束检查在本地完成。即使没有配置 AI Key，手动排班、拖拽、统计和数据持久化仍然可以使用。

## 功能概览

- A 早班、B 晚班、休假三栏排班
- 多人员独立颜色、人员管理与单人筛选
- 每张 Sheet 独立设置每日班次和休假衔接规则
- 跨日期、跨班次拖放
- 月度 A 班、B 班、总排班和休假统计
- 框选日期后批量清空，并支持撤销
- `⌘ C` / `⌃ C` 复制为日期横排、姓名竖排的 Excel 表格
- 亮色 / 暗色主题跟随系统
- SQLite 持久化与定时同步

## 本地运行

### 1. 构建前端

```bash
cd frontend
npm install
npm run build
cd ..
```

### 2. 准备后端环境

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
cp .env.example .env
```

然后编辑 `.env`，填入你自己的配置。`.env` 已被 Git 忽略，真实密钥不会进入仓库。

### 3. 启动服务

```bash
set -a
source .env
set +a
.venv/bin/gunicorn backend.app:app --bind 127.0.0.1:8094
```

打开 <http://127.0.0.1:8094> 即可使用。

## 环境变量与密钥安全

只把变量名和占位值写入 `.env.example`，真实值放在本地 `.env`、服务器私有配置或部署平台的 Secret 中：

```dotenv
DEEPSEEK_API_KEY=replace_me
DOUBAO_ASR_API_KEY=replace_me
PLAN_DATABASE_PATH=/opt/hotel-scheduler/shared/plan.db
PLAN_PORT=8094
```

- `DEEPSEEK_API_KEY`：AI 排班条件解析。
- `DOUBAO_ASR_API_KEY`：豆包语音转文字。
- `PLAN_DATABASE_PATH`：SQLite 数据库路径。
- `PLAN_PORT`：服务监听端口，默认 `8094`。

密钥只在后端读取和使用，前端不会拿到 API Key。发布前请确认没有提交 `.env`、数据库文件或任何真实凭据；如果 Key 曾经误提交，应立即吊销并重新生成。

## 项目结构

```text
backend/
  app.py              Flask API、WebSocket 语音接口与 SQLite 持久化
  scheduler_engine.py 本地排班规则引擎
  doubao_asr.py       豆包语音协议封装
frontend/
  src/App.jsx         React 日历与交互界面
  src/styles.css      响应式与主题样式
deploy/               systemd、Nginx 与版本清理配置
```

## 生产部署提示

推荐将发布代码与运行数据分离：

- 代码发布目录：`/opt/hotel-scheduler/releases`
- 当前版本：`/opt/hotel-scheduler/current`
- 数据库和环境变量：`/opt/hotel-scheduler/shared`
- Nginx 域名：`plan.mikeywa.site`

环境变量文件建议权限设为 `0640`，数据库、回滚目录和历史发布包不要打进公开仓库。

## License

当前仓库暂未指定开源许可证。如需允许他人明确地复制、修改和再发布，请补充合适的 LICENSE 文件。