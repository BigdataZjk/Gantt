# RSM v0.1.0 部署

适用于 Linux 或 macOS。默认端口 **1111**，解压后的 `rsm/` 是项目和运行根目录，可放在任意位置。

## 首次安装

1. 上传 `rsm-source-0.1.0.zip` 到服务器。支持 `rz` 时，在目标父目录执行 `rz -be`。
2. 解压并进入目录：

   ```sh
   unzip rsm-source-0.1.0.zip
   cd rsm
   chmod +x rsm.sh scripts/*.sh
   ```

   Debian 12 若没有解压工具，先执行 `apt-get update && apt-get install -y unzip`。

3. 一键部署：

   ```sh
   ./rsm.sh
   ```

   脚本自动准备构建依赖、构建并启动，最终输出访问地址。基础依赖需要 root 或 sudo；编程工具链与缓存安装在项目内。

4. 检查状态并启用自启动：

   ```sh
   ./rsm.sh status
   ./rsm.sh autostart enable
   ./rsm.sh autostart status
   ```

5. 访问 `http://服务器IP:1111`，按页面提示设置超级管理员密码。

默认无需设置路径或版本环境变量。确需指定其他运行目录或端口时，可用 `RSM_HOME=/path/to/instance RSM_ADDR=0.0.0.0:1111 ./rsm.sh`。

Go、Node 和 pnpm 的固定版本安装在项目 `.tools/` 内，不替换系统工具或修改全局配置。pnpm 在 RSM 构建进程内关闭自动换版，避免父目录配置覆盖选定版本。

Debian 安装缺失系统依赖前先检查 apt 安装计划；涉及已安装软件包的升级、替换、删除或待完成配置时中止，由管理员评估。安装只补缺失项，不执行系统升级，不通过 needrestart 自动重启其他服务；软件包索引过期时会刷新索引后重新检查。

## 源码升级

1. 在现有运行目录备份：

   ```sh
   cd /path/to/rsm
   ./rsm.sh backup
   ```

2. 将新版源码 ZIP 解压到另一个新的空目录，保留旧目录及其数据。例如，上传包位于当前目录时：

   ```sh
   mkdir -p source-upgrades/0.1.1
   unzip rsm-source-0.1.1.zip -d source-upgrades/0.1.1
   ```

3. 仍在原运行根目录，构建并升级到当前实例：

   ```sh
   RSM_HOME="$PWD" ./source-upgrades/0.1.1/rsm/rsm.sh
   ./rsm.sh status
   ```

构建期间旧服务继续运行，切换前自动备份；升级失败回退程序，不用旧备份覆盖业务数据。不要删除或用空目录替换原有 `data/`、`secrets/`、`config.json` 和 `backups/`。

## 发行包升级

发行包须匹配目标系统和架构；macOS 程序不能用于 Debian。

```sh
./rsm.sh upgrade /path/to/rsm-<版本>-linux-amd64.tar.gz
./rsm.sh status
```

独立 `.sha256` 文件可选，包内校验仍会执行。

## 备份与恢复

```sh
./rsm.sh backup
./rsm.sh verify-backup /path/to/backup.tar.gz
./rsm.sh restore /path/to/backup.tar.gz --yes
```

备份包含 SQLite 一致性快照、密钥、配置与校验清单。恢复会先备份当前实例，再停服恢复。跨机器恢复保留目标实例的监听地址。

不要直接复制运行中的数据库；迁移必须同时保留密钥。已保存及归档的需求永久保留；管理员的日志清理仅处理操作记录和指定归档日志，不删除需求。

## 目录与日志

```text
rsm/
├── .tools/、.cache/          # 自动准备的工具与依赖缓存
├── build/                   # 本机编译产物
├── releases/、current       # 已安装程序及当前版本
├── config.json              # 实例配置
├── run/                     # 进程状态与锁
├── data/                    # 数据库
├── secrets/                 # 密钥
├── logs/                    # 运行及部署日志
└── backups/                 # 备份
```

部署输出显示分步进度，详细日志默认收起；失败时展开最近错误。完整构建日志位于 `logs/deploy-details.log`，可用 `RSM_VERBOSE=1 ./rsm.sh` 实时展开。

```sh
./rsm.sh logs --follow
./rsm.sh logs -n 100
```

Linux root 使用系统级 systemd，普通账号使用用户级 systemd；macOS 使用登录后启动的用户级 launchd。移动已注册自启动的项目目录前应先停服并取消旧注册，移动后重新注册。macOS 自启动目录应避开 Documents、Desktop、Downloads 等受系统隐私保护的位置。

macOS arm64 已完成实际部署验证；Linux 的脚本与服务配置已做隔离检查，实机部署及重启仍需在目标服务器验证。
