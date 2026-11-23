# RSM v0.1.5

**Request Schedule Manager**，用于多人协作管理需求与开发排期。

排一排，更从容。

React + TypeScript 前端，Go + SQLite 后端。支持甘特图、需求池、归档、角色权限、工作日历、个人操作撤回、日夜主题和日志管理。前端资源内嵌在 Go 程序中，无需独立数据库或 Web 服务器。

需求池和归档默认按最近进池、归档时间排列。点击表头箭头可叠加多字段排序，右上角悬浮按钮恢复默认顺序。有编辑权限的用户可单击优先级格标注或取消，右键该列可清除整个需求池的标注。修改优先级时，若当前排序包含优先级，系统会清除全部排序字段并保留当前行序。再次点击表头箭头即可重新排序。

甘特图和需求池都支持双击需求名称编辑，游客双击可查看详情。三个需求视图都支持拖动需求名称列右边线调整宽度，双击边线可自动适应当前筛选内的最长需求名称。

甘特图的需求顺序和开发人由服务端保存并实时同步，管理员可将需求拖到其他开发人分组。筛选和显示范围由各浏览器控制。点击左上「优先级 / 需求」可切换全部收起、展开，缩小时右上角可重置比例。页头在线名单随成员、游客进出更新。

管理员可在甘特图工作日或已标记加班的日期右键安排补位，并关联一条未归档需求。悬停补位线段可查看需求名，拖动两端可调整日期，右键可取消补位。

## Agent 只读接口

`GET /api/agent/snapshot` 沿用游客的只读权限。从能访问 RSM 的环境调用，无需登录。返回同一 `revision` 的完整 JSON 快照，不受视图筛选或分页影响。

```sh
curl -fsS 'http://127.0.0.1:1111/api/agent/snapshot'
```

- `requests` 包含需求池和已归档需求。`request.archived` 区分两者，`request` 保留状态、提需人、链接、备注及排期原字段。`developerName` 是开发人姓名。
- `schedule` 提供甘特图线段、段间间隔及 HOLD、有效开发日期和天数。日期按当前中国大陆工作日日历计算，加班计入、休假扣除。`request.days` 是录入的人天，`schedule.scheduledDays` 是排期占用天数，`schedule.placeholder` 表示待估占位。RSM 记录的是计划排期。
- `ganttRowOrder` 提供已保存的分组需求顺序。`request.requesterRank` 是需求方在需求池标注的优先级序号，空值表示未标注。
- `support` 每段带有补位人、被补位需求和有效补位日期。以 `targetRequestId` 归到被协助的需求，以 `supporterId` 归到补位人。人员占用按人员 ID 和日期去重，同一天不同人员各计一天。

完整字段见 [OpenAPI 契约](api/openapi.yaml)。

## 一键部署

将源码解压后，在 `rsm/` 目录执行：

```sh
chmod +x rsm.sh scripts/*.sh
./rsm.sh
```

脚本自动检测并准备前置依赖、构建、安装和启动，显示分步进度，下载与构建详情写入日志。部署完成后打印访问地址，默认监听 **0.0.0.0:1111**。

- 本机：<http://127.0.0.1:1111>
- 局域网：`http://服务器IP:1111`

解压后的 `rsm/` 就是项目与运行根目录，放在哪里就使用哪里，不固定 `/app/rsm`。工具链位于 `.tools/`，依赖缓存位于 `.cache/`；配置、数据库、密钥、日志和备份均保存在该目录下。操作系统依赖与自启动注册按系统规范安装。

首次访问按页面提示设置超级管理员密码并进入，再创建成员账号。新实例不含演示需求，游客只读访问。已保存的需求及归档永久保留，日志清理不删除需求。

源码部署先校验已提交的接口类型；契约、生成器配置和类型文件一致时直接复用，避免每次下载并编译生成器。Go 依赖源短超时探测国内镜像，保留官方回退及校验。源码升级自动复用原实例的 `.tools/`、`.cache/`，减少重复下载与编译。

安装、升级和备份步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 日常管理

在部署目录执行：

```sh
./rsm.sh status
./rsm.sh start
./rsm.sh stop
./rsm.sh restart
./rsm.sh logs --follow
./rsm.sh backup
./rsm.sh verify-backup /path/to/backup.zip
./rsm.sh upgrade
./rsm.sh rollback
./rsm.sh autostart enable
./rsm.sh autostart status
./rsm.sh version
```

后续将新版源码 ZIP 放进运行目录的 `upgrade/`，执行 `./rsm.sh` 或 `./rsm.sh upgrade` 即可。脚本比较包内实际版本，选择最高新版；构建完成后自动停服、备份、切换、启动，失败时回退程序。没有新版则保持当前版本。恢复数据须显式执行 `./rsm.sh restore /path/to/backup.zip --yes`，恢复前再次备份当前数据。

手动备份默认生成 `backups/rsm-backup-v0.1.5-20261119-193015.zip`，文件名为程序版本与北京时间；同一秒重复备份自动追加序号。备份包含需求、归档、账号、密钥和配置，不需要打包整个运行目录。旧版 `.tar.gz` 备份仍可校验及恢复。

## 项目结构

```text
rsm/
├── api/                     # 接口契约及生成类型校验清单
├── cmd/rsm/                  # 服务端及备份恢复命令入口
├── internal/                 # 权限、接口、排期算法、SQLite 与历史记录
├── web/                      # React 页面、组件、样式及前端测试
├── scripts/                  # 依赖准备、构建、部署、开发与检查脚本
├── testdata/                 # 前后端共用排期测试用例
├── rsm.sh                    # 部署与日常管理入口
├── go.mod / go.sum           # Go 依赖及校验
├── DEPLOYMENT.md             # 安装、升级与数据管理说明
├── README.md
└── LICENSE
```

首次部署后自动生成 `.tools/`、`.cache/`、`build/`、`releases/`、`current`、`config.json`、`run/`、`data/`、`secrets/`、`logs/` 和 `backups/`，均不纳入 Git。

## 开发与验证

```sh
./scripts/dev.sh
./scripts/check.sh
./scripts/check.sh --e2e
```

开发页面使用 `0.0.0.0:1111`，内部 API 使用 `127.0.0.1:8080`。浏览器回归使用独立数据目录；运行完整 E2E 前须确保测试所用端口空闲。

```sh
./scripts/generate.sh                  # 生成接口类型
./scripts/generate.sh --check          # 实际重新生成并核对类型与校验清单
./scripts/build.sh                     # 按项目版本构建，产物位于 build/
./scripts/build.sh --version 0.1.5     # 显式覆盖构建版本
./scripts/package-source.sh            # 将已提交源码打包到桌面
```

契约或生成器配置变更后运行 `generate.sh`，同时提交类型文件和 `api/generated.sha256`；打包会拒绝过期的校验清单。

产品版本记录在 `web/package.json`。构建版本优先级为 `--version`、`RSM_VERSION`、Git 精确标签、项目版本。源码 ZIP 默认保存在 `~/Desktop/rsm-source-<版本>.zip`，顶层目录为 `rsm/`，内容与当前提交一致。

仓库仅保留源码、必要配置、依赖锁文件、测试源码和使用文档。运行数据、密钥、依赖缓存、构建产物、历史交接资料及压缩包不提交。

## 平台

支持 macOS 和 Linux，架构为 amd64 或 arm64。首次源码部署需要联网，脚本自动准备固定版本的 Go、Node、pnpm 及所需编译依赖，不维护离线依赖包。

macOS arm64 已验证源码部署、升级、回退、备份、恢复及 launchd。Linux 支持 systemd 和现有 Supervisor；systemd 通过受控回归，Supervisor 通过独立管理器及另一项持续运行服务的隔离验收。Linux 实机及宿主机重启仍需在目标服务器验证。Supervisor 回归可在装有该工具的独立 Python 环境中运行 `python scripts/tests/supervisor-integration.py`，需要已有 `build/rsm`。
