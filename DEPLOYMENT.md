# RSM v0.1.2 部署

适用于 Linux 或 macOS。默认端口 **1111**，解压后的 `rsm/` 是项目和运行根目录，可放在任意位置。

## 首次安装

首次安装使用空目录，启动后按提示设置超级管理员密码。已部署的实例使用下方「后续升级」流程，保留现有数据和账号。

1. 上传 `rsm-source-0.1.2.zip` 到服务器。支持 `rz` 时，在目标父目录执行 `rz -be`。

   纯网页终端不支持 `rz` 弹窗时，在目标目录粘贴配套 `rsm-upload-0.1.2.txt` 的全部内容。文本只生成源码 ZIP，传输完成后自动校验 SHA256，再继续解压。
2. 解压并进入目录：

   ```sh
   unzip rsm-source-0.1.2.zip
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

源码包已含生成的接口类型及校验清单，一致时直接复用。Go 依赖默认短超时探测国内源，按可用性选择 `goproxy.cn`、官方源或 `goproxy.io`，请求失败可依次回退；保持 Go 校验库、依赖锁文件及安装包 SHA256 校验。已有 `GOPROXY`、`GOSUMDB` 环境配置优先，只影响本次构建进程。

Debian 安装缺失系统依赖前先检查 apt 安装计划；涉及已安装软件包的升级、替换、删除或待完成配置时中止，由管理员评估。安装只补缺失项，不执行系统升级，不通过 needrestart 自动重启其他服务；软件包索引过期时会刷新索引后重新检查。

## 后续升级

0.1.1 起，安装时自动创建 `upgrade/`。升级只需：

1. 将新版源码 ZIP 上传到原运行目录的 `upgrade/`，例如 `rsm/upgrade/rsm-source-0.1.2.zip`。也可在原运行目录粘贴新版上传 TXT，自动保存到 `upgrade/` 并校验 SHA256。
2. 在原运行目录执行：

   ```sh
   ./rsm.sh
   ```

   `./rsm.sh upgrade` 等效；需要指定某个包时可用 `./rsm.sh upgrade /path/to/source.zip`。

脚本读取各 ZIP 内 `rsm/web/package.json` 的实际版本，按主、次、修订版本数值选择最高版本，不依赖文件名或上传时间。当前已是最新版本时不重复构建、停服；没有升级包时直接确保当前程序运行。同一最高版本有多个内容不同的包时中止，避免误选；需要同版本重装时显式加 `--force`。

构建复用原实例 `.tools/` 和 `.cache/`，旧服务继续运行；构建成功后自动短暂停服、创建一致性备份、切换并启动，健康检查失败自动回退程序。解压及构建在项目内临时目录进行，结束后清理。需求、归档、账号、密码、密钥、配置和原访问地址保留；不要删除旧运行目录，也无需手动解压、停启或额外备份。

完成后浏览器刷新即可。查看状态与版本可用 `./rsm.sh status`、`./rsm.sh version`；回退程序用 `./rsm.sh rollback`，回退不会恢复旧数据库。

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
./rsm.sh verify-backup /path/to/backup.zip
./rsm.sh restore /path/to/backup.zip --yes
```

备份默认保存为 `backups/rsm-backup-v0.1.2-20261118-233015.zip`。文件名依次为程序版本、北京时间日期与时分秒，同一秒重复备份追加 `-1`、`-2`，不会覆盖；命令结束会打印本次完整路径。执行 `ls -lt backups/*.zip`，第一项为最新备份。

ZIP 包含 SQLite 一致性快照、密钥、配置与校验清单，覆盖需求、归档与账号；可在服务运行时备份，无需压缩整个项目。旧版 `.tar.gz` 仍可校验和恢复。恢复会先备份当前实例，再停服恢复。跨机器恢复保留目标实例的监听地址。

下载到 Mac：终端支持 ZMODEM 才能用 `sz`。有 SSH 通道时，在 Mac 执行 `scp 用户@服务器:/实际路径/rsm/backups/实际文件.zip ~/Desktop/`。只有纯网页终端时，小备份可执行 `base64 -w 0 backups/实际文件.zip`，复制完整输出，再在 Mac 执行 `pbpaste | base64 -D > ~/Desktop/实际文件.zip`；用 `unzip -t ~/Desktop/实际文件.zip` 校验下载。若网页终端截断输出，应改用 SSH/SFTP 或平台文件导出功能。源码 ZIP 只含程序代码，不是业务备份。

不要直接复制运行中的数据库；迁移必须同时保留密钥。已保存及归档的需求永久保留；管理员的日志清理仅处理操作记录和指定归档日志，不删除需求。

## 目录与日志

```text
rsm/
├── .tools/、.cache/          # 自动准备的工具与依赖缓存
├── build/                   # 本机编译产物
├── upgrade/                 # 上传待升级源码 ZIP，脚本读取包内版本
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

Linux 使用 systemd（root 为系统级，普通账号为用户级）；PID 1 为 `supervisord` 时复用现有 Supervisor，不安装或重启服务管理器。`./rsm.sh autostart enable` 自动核实运行中管理器的配置及 include 目录，为当前路径创建独立的 `rsm-<路径摘要>` 进程组。先校验配置，再短暂停止本实例并接管；失败时恢复原后台运行。后续启停、升级和禁用均限定到本实例，其他进程组的待更新配置也不会应用。配置无法确认时安全中止；确需指定时可设置 `RSM_SUPERVISOR_CONFIG=/path/to/supervisord.conf`。

Supervisor 接管后，RSM 随现有 supervisord 启动；宿主机是否自动启动容器由平台管理。macOS 使用登录后启动的用户级 launchd。移动已注册自启动的项目目录前应先停服并取消旧注册，移动后重新注册。macOS 自启动目录应避开 Documents、Desktop、Downloads 等受系统隐私保护的位置。

macOS arm64 已完成实际部署验证；systemd 已做受控回归，Supervisor 已用独立管理器及另一项持续运行的服务验收。Linux 实机部署及宿主机重启仍需在目标服务器验证。
