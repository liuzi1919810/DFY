# dsh-poke · 戳一戳

会话任务跑完时戳你一下。像 QQ 的戳一戳，但不抖窗口、不抢焦点、不把窗口顶到最前。

DeepSeek Harness 插件（bundle），由两部分组成：Host 半负责配置和 Windows 通知，Client 半负责右上角卡片。

> Poke-style notice for DeepSeek Harness: an in-app card or a real Windows toast when a Session task finishes.

## 行为

DSH 会话列表里某个会话从「运行中」变成「不运行中」，就算任务结束；时长从它开始运行算到停下。

- 只有跑满设定时长的任务才提醒，短任务不打扰
- 窗口在前台 → 右上角滑出一张卡片，写会话标题 + 用时，点一下跳到那个会话
- 窗口在后台（包括你在打游戏）→ 只发 Windows 系统通知，不弹卡片
- 卡片浮在所有页面之上，但切到后台时会被其他窗口正常盖住，不会置顶抢焦点
- 8 秒自动消失，也可以点 ×；点卡片会调到对应会话并 `window.focus()`

**等回答也会戳。** 会话进入「等你回答」（DSH 的提问）时，走和任务结束一样的通道：前台弹卡片（圆点是橙色，跟「跑完了」区分）、后台发通知。每个新问题只戳一次，页面打开时已经存在的问题不补戳；时长门槛不适用于提问。

## 系统通知为什么走宿主

Electron 渲染进程里的 `new Notification()` 在 Windows 上经常被静默丢弃——应用标识（AUMID）跟任务栏快捷方式对不上时，系统不报错也不显示。

所以 toast 由 Host 半用 Windows Runtime 直接发（`ToastNotificationManager`），标题「戳一戳」，正文是会话标题和用时，显示名跟随任务栏快捷方式。

## 下载

- 打包好的插件（直接下）：https://github.com/liuzi1919810/DFY/releases/latest
- 源码压缩包：https://github.com/liuzi1919810/DFY/archive/refs/heads/main.zip

## 安装

需要 DSH 桌面版 + Windows（toast 依赖 WinRT）。

方式一，GitHub 直装（推荐）：

```
dsh plugin --profile desktop add github:liuzi1919810/DFY
```

装完在 插件页 确认「戳一戳」这一行是启用状态，然后刷新页面。

> 仓库名是 `DFY`，包名是 `@local/dsh-poke`，装的时候用仓库地址就行。

方式二，下载 Release 里的 `.tgz` 后安装：

```powershell
dsh plugin --profile desktop add file:<tgz 绝对路径>
```

> 别用「本地目录」方式装：DSH 对本地目录是软链安装，`@deepseek-ai/schemastery` 会从工作区解析不到，插件激活失败。tgz 或 GitHub 装出来是真实目录，能正常解析。

## 配置

插件页 → 戳一戳 → 行右侧的「配置」。表单由插件自己画（DSH 不会给插件自动生成表单），保存走设置写入接口，带 revision 防并发覆盖。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto` 前台卡片、后台通知；`popup` 只弹卡片；`notification` 只发通知 |
| `minDurationSeconds` | `5` | 跑够多少秒才提醒，0 表示全都提醒 |
| `popupSeconds` | `8` | 卡片停留秒数 |
| `ignoreSubagents` | `true` | 忽略子智能体会话 |
| `windowsAppId` | `electron.app.DeepSeek Harness` | toast 使用的 Windows 应用标识，必须和任务栏快捷方式一致，否则系统静默丢弃 |

改完点「保存」，状态栏会显示「已保存」；写入失败会显示宿主拒绝的原因。字段都是 volatile，改完不用重启插件，页面最多 15 秒内跟上新设置。

## 已知限制

- 只测了 Windows + DSH 桌面版；卡片在浏览器里也能显示，但 toast 是 Windows 专属
- 计时从「页面看到运行中」开始。页面刚刷新或刚启动时，已经在跑的任务会少算前面那段时间
- Windows 通知点击不会跳会话——WinRT 的激活回调需要注册 COM 处理器，这版没做
- 子智能体会话默认忽略；父会话结束才戳
- 提问提醒只在页面打开时看得到；DSH 没有把提问推到宿主侧，所以页面没开就不会有提醒

## 许可

MIT
