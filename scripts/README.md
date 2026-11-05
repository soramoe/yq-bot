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

## 注意

- 端口固定 `8900`；要换端口改 `start.bat` 里的 `PORT`，同时改
  `health.mjs` 读取的 `PORT` 环境变量或命令行。
- 脚本里没有写死盘符之外的项目路径，整个文件夹搬到别处也能用。
- B 站登录账号仍叫「渔月崽」，那是账号名；产品显示名是
  「渔情 B 站直播助手机器人」，两者不是一回事。
