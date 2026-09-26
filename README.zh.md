# @goodandready/dsh-smart-restart

<div align="center">
<h3>让重启经过验证，而不只是发出通知。</h3>
<p align="center"><a href="https://www.npmjs.com/package/@goodandready/dsh-smart-restart">npm package</a> · <a href="LICENSE">MIT</a> · <a href="https://github.com/topics/dsh-plugin">DSH plugin</a></p>
<p align="center"><a href="https://goodandready.app/">DSH Hub — goodandready.app</a></p>
<p align="center"><a href="README.md">English</a> • <a href="README.zh.md"><b>中文</b></a> • <a href="README.ru.md">Русский</a></p>
<table align="center"><tr><td align="center">
⭐ <strong>如果您喜欢这个插件，请在 GitHub 上为它点亮 Star</strong> — 这能让我知道插件对您有用，并鼓励我继续维护它。
<br><br>
🐛 <strong>如果您发现 Bug 或希望增加功能</strong>，请使用任意语言在 GitHub 上提交 Issue。
</td></tr></table>
</div>

## 概述

重启会终止执行该操作的进程。普通通知只能说“服务已重启”，却无法回答两个关键问题：Harness 现在是否健康，以及被中断的任务应该继续什么。直接调用 systemctl restart 还可能需要 root 或 polkit 权限。

本插件为 DeepSeek Harness 提供经过验证的重启流程：先记录原因、目标会话和待继续任务，再结束当前进程让 systemd 启动新进程。新进程执行健康检查，并把结果和恢复提示发回发起请求的会话。默认方式无需额外权限。

## 架构

~~~mermaid
graph LR
  A[DSH web profile] --> B[Host plugin]
  B --> C[Restart intent and guard]
  C --> D[Service manager restarts DSH]
  D --> E[Next-process health checks]
  E --> F[Report to requesting session]
  A --> G[Client module loader]
  G --> H[Settings card]
  H --> B
~~~

浏览器端通过 DSH 的延迟 CommonJS 客户端加载器注册设置卡片；工厂返回 apply 和 inject。宿主端负责工具、重启、健康检查和报告。

## 功能

- **无需额外权限重启**：默认结束 Harness 进程，由配置为 Restart=always 的 systemd 拉起；systemctl 模式适用于已授予相应权限的环境。
- **启动后健康检查**：检查 DSH 服务、已注册工具、systemd 单元状态及重启次数、监听端口是否由本服务 cgroup 中的进程持有，以及插件和核心版本。结果为 ok 或带失败明细的 degraded。
- **报告发回原会话**：重启前保存目标会话、原因和待继续内容；新进程将检查结果发回同一会话，必要时会有限等待会话上线。
- **循环保护**：10 分钟窗口内达到 3 次重启上限后拒绝新请求。
- **设置卡片**：提供英文和中文界面；俄语翻译由 dsh-russian-lang 提供。

## Модули

- lib/index.js：Cordis 宿主入口，注册设置、重启/状态工具、启动检查与报告发送。
- lib/boot.js：纯函数逻辑，识别重启、保护循环、检查 cgroup 和端口、汇总结果并格式化报告。
- lib/client.js：浏览器设置卡片；DSH 加载工厂必须返回 CommonJS 导出对象。
- cordis.patch.yml：将此包加入所选 web profile。

## 安装

~~~bash
dsh plugin --profile web add @goodandready/dsh-smart-restart
~~~

默认模式要求 Harness 由 systemd 管理，且服务配置 Restart=always。插件从进程 cgroup 自动检测单元，也可以在设置中指定。

## 设置

在 DSH 插件设置卡片中修改；不需要密钥。

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| enabled | boolean | true | 是否注册工具并检查每次启动。 |
| restartMode | string | kill | kill 结束进程并由 systemd 重启；systemctl 调用 systemctl restart <unit>。 |
| unit | string | 自动检测 | 要检查和重启的 systemd 单元；空值从 /proc/self/cgroup 检测。 |
| delayMs | number | 3000 | 结束进程前的等待时间，让工具回执先返回。 |
| target | string | requester | 报告目标：发起请求的会话、primary 或会话 ID。 |
| stateDir | string | .restart-guard | $DSH_HOME 下保存启动标记、意图、报告和重启历史的目录。 |
| maxRestarts | number | 3 | 窗口内达到该次数时拒绝重启。 |
| windowMs | number | 600000 | 循环保护窗口，单位毫秒。 |
| timeoutMs | number | 5000 | 每项健康探测的超时时间。 |
| expectTools | string[] | [] | 启动后必须注册的工具；缺失会降低健康结论。 |
| toolEnabled | boolean | true | 是否注册 dsh_restart 和 dsh_restart_status。 |

## 工具

- dsh_restart：参数 reason、resume、confirm 和 delayMs。保存意图、检查循环限制、安排重启并返回回执；重启后的结论会发给调用它的会话。
- dsh_restart_status：只读显示最近启动、停机时长、健康报告、待处理意图和当前窗口中的重启次数。

## 报告

报告包含启动时间、停机时长、每项健康检查结果、插件/核心版本、总体结论，以及重启前记录的待继续内容。值缺失时不会伪造健康状态。

## 限制与故障排查

- 默认模式依赖 systemd 的 Restart=always。手动启动的独立进程无法自行恢复，插件会明确报告这一限制。
- kill 模式会结束当前执行轮次；保存的意图用于为下一轮提供上下文。
- 端口和 cgroup 检查面向 Linux；其他系统会跳过这些检查。
- 插件由 DSH 包管理器 (CLI/pnpm) 统一管理；本插件不提供独立的 /api/dsh/update 路由，更新会在重启后由内置 health-check 验证。
- 对于 systemd 用户单元，--user 标志会在状态检查和 systemctl restart 中自动传递。
- 如果 DSH 报告客户端导入失败并提示 module is not defined，说明客户端加载工厂不兼容。请使用定义并返回 CommonJS 导出的版本，再重新加载 web profile。
- 宿主端工具可能正常，而浏览器设置卡片仍失败；请分别检查客户端模块启动错误。

## 开发与许可证

运行 npm test 执行测试。

MIT © GooDAnDReaDY
