# RSM v0.1.1

**Request Schedule Manager**，用于多人协作管理需求与开发排期。

排一排，更从容。

React + TypeScript 前端，Go + SQLite 后端。支持甘特图、需求池、归档、角色权限、工作日历、个人操作撤回、日夜主题和日志管理。前端资源内嵌在 Go 程序中，无需独立数据库或 Web 服务器。

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
./rsm.sh verify-backup /path/to/backup.tar.gz
./rsm.sh upgrade
./rsm.sh rollback
./rsm.sh autostart enable
./rsm.sh autostart status
./rsm.sh version
```

后续将新版源码 ZIP 放进运行目录的 `upgrade/`，执行 `./rsm.sh` 或 `./rsm.sh upgrade` 即可。脚本比较包内实际版本，选择最高新版；构建完成后自动停服、备份、切换、启动，失败时回退程序。没有新版则保持当前版本。恢复数据须显式执行 `./rsm.sh restore /path/to/backup.tar.gz --yes`，恢复前再次备份当前数据。

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
./scripts/build.sh --version 0.1.1     # 显式覆盖构建版本
./scripts/package-source.sh            # 将已提交源码打包到桌面
```

契约或生成器配置变更后运行 `generate.sh`，同时提交类型文件和 `api/generated.sha256`；打包会拒绝过期的校验清单。

产品版本记录在 `web/package.json`。构建版本优先级为 `--version`、`RSM_VERSION`、Git 精确标签、项目版本。源码 ZIP 默认保存在 `~/Desktop/rsm-source-<版本>.zip`，顶层目录为 `rsm/`，内容与当前提交一致。

仓库仅保留源码、必要配置、依赖锁文件、测试源码和使用文档。运行数据、密钥、依赖缓存、构建产物、历史交接资料及压缩包不提交。

## 平台

支持 macOS 和 Linux，架构为 amd64 或 arm64。首次源码部署需要联网，脚本自动准备固定版本的 Go、Node、pnpm 及所需编译依赖，不维护离线依赖包。

macOS arm64 已验证源码部署、升级、回退、备份、恢复及 launchd。Linux 支持 systemd 和现有 Supervisor；systemd 通过受控回归，Supervisor 通过独立管理器及另一项持续运行服务的隔离验收。Linux 实机及宿主机重启仍需在目标服务器验证。Supervisor 回归可在装有该工具的独立 Python 环境中运行 `python scripts/tests/supervisor-integration.py`，需要已有 `build/rsm`。
