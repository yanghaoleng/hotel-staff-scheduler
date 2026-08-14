# 祥宇·排班表

为 Jennie 制作的公共协作酒店排班网页。每位员工使用固定颜色，支持多 Sheet、月历查看、三栏拖放、月度统计、Excel 复制和 DeepSeek V4 Flash 自然语言排班。

## 已实现

- 放大月历与右侧岛式工具栏，860px 及以上保持左右双栏，低于 860px 改为上下排列
- 375 宽屏幕完整显示 7 天，人名自动缩为首字
- 移动端滚动时吸附年月和星期栏，Sheet 标题正常滑走
- 每天固定 A 早班、B 晚班、休假三栏
- 员工独立颜色与人员管理，删除前二次确认，之后可用同名恢复
- 每张 Sheet 可独立设置「每天 1 个 A、1 个 B」和「休假前 A、收假后 B」固定规则
- 同日跨栏或跨日期拖放班次
- 每条 A、B、休假栏可直接点击加号选人，无需打开完整编辑器
- 单人显隐，以及双击或长按进入只看此人
- 当月每人的 A 班、B 班、排班和休假明细
- 框选连续日期后用 Delete 批量清空，10 秒内可点击撤销或用 ⌘ Z / ⌃ Z 撤销
- 用 ⌘ C / ⌃ C 复制为日期横排、姓名竖排的 Excel 表格
- DeepSeek V4 Flash 只把自然语言解析成排班条件，本地规则引擎再生成排班，避免 AI 少排、漏排或违反固定规则
- 月份和框选日期都可打开智能排班输入框，框选工具条会跟随选区显示在上方或下方
- 所有排班条件输入框支持豆包流式语音转文字，再次点击麦克风即可停止
- AI 新增班次按日期顺序从上方旋转落入，使用弹簧回弹动画
- 页面右上角集中展示快捷键，AI 输入框支持 Enter 生成、Shift+Enter 换行
- AI 批量修改一键撤销
- 明亮、暗色主题自动跟随系统，Safari 顶部状态栏同步主题色
- 无账号、无登录，打开网页即可共同编辑
- 多张独立排班 Sheet，所有人都可以创建、改名和删除
- 页面每 12 秒自动同步其他人的修改
- SQLite 持久化数据
- Jennie 2026 年 8 月 10-16 日截图排班已导入

## 本地运行

```bash
cd frontend
npm install
npm run build

cd ..
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
PLAN_DATABASE_PATH=/tmp/hotel-scheduler.db \
.venv/bin/gunicorn backend.app:app --bind 127.0.0.1:8094
```

打开 `http://127.0.0.1:8094` 即可编辑。

## 服务器环境变量

真实密钥只放在 `/opt/hotel-scheduler/shared/app.env`，文件权限应为 `0640`，不要提交到 Git。

```dotenv
DEEPSEEK_API_KEY=replace_me
DOUBAO_ASR_API_KEY=replace_me
PLAN_DATABASE_PATH=/opt/hotel-scheduler/shared/plan.db
PLAN_PORT=8094
```

## 发布与空间保护

- 应用发布目录：`/opt/hotel-scheduler/releases`
- 数据与环境变量：`/opt/hotel-scheduler/shared`
- 当前版本软链接：`/opt/hotel-scheduler/current`
- Nginx 域名：`plan.mikeywa.site`
- 服务器已安装每日发布版本修剪任务，首页与 Massage OS 均只保留最近 3 个版本。
- 发布包应来自干净工作区或 `git archive`，禁止把 `previous`、`rollback`、`releases`、数据库和环境变量打进新版本。
