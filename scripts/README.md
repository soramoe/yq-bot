# 渔情 B 站直播助手机器人 · 本地脚本

脚本都在这个目录，只用系统自带的 `cmd` / `node`，不需要管理员权限
（注册计划任务时 Windows 可能弹一次确认）。

## 第一次使用

```
scripts\install.bat
```

会检查 Node（要求 >= 22）、创建 `logs\` 和 `data\`、安装运行时依赖 `ws`，
然后打印下一步该敲什么。它不会启动服务。

## 日常

```
scripts\start.bat      启动（后台隐藏窗口）
scripts\stop.bat       停止（并留下暂停标记）
scripts\restart.bat    重启
scripts\status.bat     看状态：版本、运行时长、房间、账号、直播态
```

启动是幂等的：已经在跑就打印 `[SKIP] already running`，不会重复开进程。
判断“在跑”看的是 `/api/status` 里的 `app` 字段，而不是端口有没有人监听——
否则别的程序占了 8900，脚本会以为自己的服务已经起来了。

停止会写 `logs\service.paused`。每 5 分钟的巡检任务看到这个标记就不会
自动拉起服务，所以“停了又被拉起来”不会发生。手动 `start.bat` 会清掉标记。

## 登录与换号

服务在跑时打开 `http://127.0.0.1:8900/login`（或设置页「维护 → 账号 →
切换账号」）扫码即可。登录成功后服务会自己重连房间，**不用 stop/start**。
服务没起时才用 `npm run login`（独立 8898）。

## 开机自启 / 巡检

```
scripts\install-autostart.bat     登录自启（延迟 30 秒）+ 每 5 分钟巡检
scripts\uninstall-autostart.bat   删除这两个任务
```

任务名是 `YuQing-Bot-Boot` 和 `YuQing-Bot-Watch`，都调用
`scripts\autostart.bat`（`start.bat auto`，尊重暂停标记）。

## 文件

```
install.bat              检查环境 + 装依赖
health.mjs               健康探针（0=在跑，1=没跑，3=端口被别的程序占了）
launch-hidden.vbs        隐藏窗口启动 node server\main.mjs
start.bat                启动
stop.bat                 停止
restart.bat              重启
status.bat               状态
autostart.bat            计划任务调用的包装（start.bat auto）
install-autostart.bat    注册计划任务
uninstall-autostart.bat  删除计划任务
```

日志在 `logs\service.out.log`（超过 5MB 时启动会轮转成 `.1`）。
PID 在 `data\run.pid`，暂停标记在 `logs\service.paused`。

## 更新镜像（可选）

没有代理的机器连不上 GitHub 时，把更新包搬到自己的 https 静态目录：

```
# 本地目录（nginx / Caddy 指过去）
node scripts\mirror-release.mjs --dir D:\mirror\yq --keep 5 --base https://mirror.example.com/yq

# S3 兼容存储（R2 / MinIO / AWS；OSS、COS 的 S3 接口也可）
set S3_ACCESS_KEY=...
set S3_SECRET_KEY=...
node scripts\mirror-release.mjs --s3 yq-mirror --endpoint https://<账号>.r2.cloudflarestorage.com --region auto --prefix yq

# 只看会发布什么，不写不传
node scripts\mirror-release.mjs --dir D:\mirror\yq --dry-run
```

默认从 `data/app.json` 的 `updateUrl` 读清单；也可以 `--manifest <url>` 指定。
CI 里用 `--manifest-file latest.json --package-file <本地包>`，不联网也能发布。
程序要求镜像目录里同时有 `latest.json` 和清单 `download` 最后一段同名的包；
脚本会校验 `size` 和 `sha256` 再落盘，传上去的内容和 Release 一致。

`--allow-http` 只用于本地自检，公网镜像必须是 https。

### 发版自动同步（可选）

在 GitHub 仓库 Settings → Secrets and variables → Actions 里加：

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- 可选 `R2_ENDPOINT`（默认本项目的 R2 账号地址）
- 可选 `R2_BUCKET`（默认 `yq-mirror`）

之后打 `v*` tag 发版，release workflow 会自动把 `latest.json` 和包传到
`<镜像>/yq/`，并检查公开地址是否已读到新版本。没配这些 secrets 时这一步
直接跳过，Release 不受影响。

## 注意

- 端口固定 `8900`；要换端口改 `start.bat` 里的 `PORT`，同时改
  `health.mjs` 读取的 `PORT` 环境变量或命令行。
- 脚本里没有写死盘符之外的项目路径，整个文件夹搬到别处也能用。
- B 站登录账号仍叫「渔月崽」，那是账号名；产品显示名是
  「渔情 B 站直播助手机器人」，两者不是一回事。
