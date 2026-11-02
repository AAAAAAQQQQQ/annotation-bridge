<div align="center">

<h1>annotation-bridge</h1>

<sub>在网页上标注元素、写下意见，一次性投递到 <b>Codex / Claude / DeepSeek Harness</b> 的会话，并显示回复和调用链。</sub>

<br/><br/>

<img alt="license" src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square">
<img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-1f6feb?style=flat-square">
<img alt="chrome" src="https://img.shields.io/badge/Chrome-Manifest%20V3-4285f4?style=flat-square">
<img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square">
<img alt="status" src="https://img.shields.io/badge/status-0.1.0%20beta-d97706?style=flat-square">

</div>

---

## 它解决什么

对着网页改 UI 的时候，你现在的流程大概是：

> 看页面 → 心里记着"那个卡片""右边那个按钮" → 切到终端 → 用文字描述它在哪 → agent 猜错 → 再描述一遍

**annotation-bridge 把"描述"换成"指给 agent 看"**——你直接点元素，它拿到的是 `.card:nth-of-type(3)` 这种 agent 能直接 grep 的东西。

而且不用一条一条发：攒一批，一次性投递。

---

## 支持哪些会话

| 工具 | 列会话 | 发消息 | 换模型 | 换推理强度 | 读调用链 |
|---|---|---|---|---|---|
| **Codex** | ✅ 去重后按最近使用 | ✅ `codex queue`（排队，注入正在跑的会话） | ⚠️ 仅「续跑」模式：`codex exec resume -m` | ⚠️ 仅「续跑」模式：`-c model_reasoning_effort=` | ✅ |
| **DeepSeek Harness** | ✅ 解压 `session.v4.jsonl.zstd` | ✅ `dsh headless --session-id` | ❌ headless 没有 model 参数 | ❌ | ✅ |
| **Claude Code** | ✅ 读 `~/.claude/projects` | ⚠️ 需要 `claude` CLI（本机未安装，页面里显示为灰） | ✅ `--resume -p --model` | — | ✅ |

模型列表和每个模型支持的强度**不是写死的**，启动时跑 `codex debug models` 拉官方目录：

```text
gpt-6.1-sol     default=low     支持=low,medium,high,xhigh,max,ultra
gpt-6-astra     default=medium  支持=low,medium,high,xhigh,max,ultra
gpt-6-luna      default=medium  支持=low,medium,high,xhigh,max
```

面板里选了模型，强度下拉只列这个模型真支持的档位。

**排队 ≠ 续跑**，这两个不是一回事：

- **排队（queue）** —— 把消息塞进**正在跑**的那个会话的队列。**任何 `-c` 覆盖都会被拒绝**（`cannot queue through an embedded app server while a local app-server daemon is running`），所以模型和强度都不能换。适合"我一边看着它干活，一边插话"。
- **续跑（resume / headless / print）** —— 起一个**独立进程**接上同一个会话，能把模型换掉。适合"这批改完就用 X 模型重跑一遍"。两个进程同时挂同一个会话会打架。

## 演示

**① 选会话**

侧边栏列出你最近用过的 Codex 会话（按 `~/.codex/sessions` 里最后修改时间排序），点一个就行。也可以直接粘贴会话 UUID。

**② 点元素，写备注**

点「选择元素」，页面进入拾取模式（元素高亮、顶部提示条）。点一下目标元素：

```text
body > main > .card:nth-of-type(3)
div · BR 36 / 40 · N/30 对照
```

再写一句 `这个卡片间距太挤`，选严重度，**加入队列**。

**③ 全部发送**

队列里攒了 3 条，点「全部发送」，bridge 把它们合成一条消息：

```markdown
【网页标注 · 3 条】 来源：http://127.0.0.1:8080/review/

我在页面上标了下面几处，请按选择器定位代码后逐条修改：

1. `body > main > .card:nth-of-type(3)`
   元素文本：BR 36 / 40 · N/30 对照
   严重度：important
   备注：这个卡片间距太挤

2. `h1.title`
   严重度：suggestion
   备注：标题字号建议 28px

改完逐条说明改了什么。
```

然后面板自动轮询，把 Codex 的回复贴回来。

> 真实回执（本机跑出来的）：
> ```json
> {"count": 2, "thread": "01a18c4a-…", "ok": true,
>  "cmd": "codex queue --thread 01a18c4a-… --message <218 字> --resume"}
> ```

---

## 安装

### 1. 起 bridge

```bash
git clone https://github.com/AAAAAAQQQQQ/annotation-bridge.git
cd annotation-bridge
./start.sh
```

看到 `[annotation-bridge] http://127.0.0.1:47391` 即可。零依赖，只要 Node ≥ 20。

### 2. 装扩展

1. Chrome 打开 `chrome://extensions`
2. 右上角开 **开发者模式**
3. **加载已解压的扩展程序** → 选 `extension/` 目录

> **装不上？** 正式版 Chrome 从 137 起不再支持 `--load-extension` 命令行参数（静默忽略、不报错），
> 只能用 `chrome://extensions` 手动加载。原因和实测记录见 [docs/loading-unpacked-extensions.md](docs/loading-unpacked-extensions.md)。

#### 连不上本地服务？

Chrome 从 **142** 起默认启用 **Local Network Access**：从公共来源访问 `127.0.0.1` 需要用户授权，
而扩展页拿不到那个授权弹窗，请求会被直接拦掉（报 `Failed to fetch`，和"服务没开"一模一样）。

打开 `chrome://flags/#local-network-access-check` → 设为 **Disabled** → 重启浏览器。

### 3. 用

点工具栏图标 → 侧边栏从右侧弹出。

---

## 工作原理

<div align="center">
  <img src="assets/flow.svg" alt="工作流程" width="920">
</div>

关键点：**投递走的是 Codex 官方子命令**，不是逆向：

```bash
codex queue --thread <session-uuid> --message "<text>" --resume
```

`--resume` 表示：如果那个会话当前没有进程在跑，试着把它拉起来。

回复则是读会话 jsonl 里的 `response_item` / `message` / `role=assistant`。

---

## 界面

<div align="center">
  <img src="assets/screenshot.png" alt="侧边栏界面" width="360">
  <br/>
  <sub>真机截图 · Chrome for Testing 148 · 三个工具可切换、可选发送模式和模型</sub>
</div>

---

## HTTP 接口

bridge 就监听在 `127.0.0.1:47391`，不连外网。你可以直接拿它当 CLI 用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活 + 当前 codex 路径 |
| GET | `/sessions?limit=60` | 会话列表（5 秒缓存） |
| GET | `/messages?thread=&limit=` | 某会话最近消息 |
| POST | `/queue` | 入队 `{thread, comment, selector, text, url, severity}` |
| GET | `/queue?thread=` | 查队列 |
| POST | `/queue/clear` | 清空 |
| POST | `/send` | 投递该会话的整个队列 |
| GET | `/reply?thread=&since=` | 投递之后的新回复 |

```bash
curl -s 127.0.0.1:47391/health
curl -s '127.0.0.1:47391/sessions?limit=5' | jq '.sessions[] | {id, project, title}'
```

---

## 一些实现细节

**会话去重** —— 一个 Codex 会话会往磁盘写多个 `rollout-*.jsonl`（同一个 `session_id`）。直接列目录会看到一堆重复项，所以按 `session_id` 去重，只留最新的文件。

**只读文件头** —— `~/.codex/sessions` 可能有几个 GB，扫的时候只读每个文件的前 256KB 拿元信息，不整文件读。

**选择器稳定性** —— 优先级 `#id` → `[data-*]` → `tag.class:nth-of-type(n)` 链（最多 6 层），并过滤 `active` / `hover` / `is-*` 这类状态类名，避免选择器随交互变化。

**CORS** —— 扩展走 `host_permissions` 直连 localhost，不依赖服务端放行。

---

## 已验证

`test/probe.mjs` 会真的把扩展装进 Chrome、打开面板、往测试页点一个元素、入队、发送，并打印每一步：

```text
✅ 扩展已加载  id = cghelop…
✅ 侧边栏页面已打开
   面板状态: {"status":"已连接 · 6 个会话","sessions":6}
   进入拾取模式: {"ok":true}
   拾取结果回传面板: {"selector":"div.card:nth-of-type(2)","text":"div · 卡片二 目标簇数 261 ± 20"}
   入队后: {"count":"1","items":1}
   发送后: {"hint":"已投递 1 条（DRY_RUN），等待回复…"}
```

自己跑：

```bash
DRY_RUN=1 node bridge.mjs &    # 安全模式：只合成消息，不真的投递
node test/serve.mjs &
node test/probe.mjs
```

> `DRY_RUN=1` 不能省——否则真的会往你选中的那个会话里投消息。

---

## 已知限制

1. **Claude 只有只读那一半。** 这台机器上没装 `claude` CLI，所以 Claude 页签是灰的，只能读历史不能发。装好 CLI 后适配器已经就位（`claude --resume <id> -p --model <m>`）。
2. **「排队」不等于「立即执行」。** 消息进的是该会话的队列，能不能立刻跑取决于 Codex 的 app-server 状态。
3. **换模型的代价。** Codex 换模型必须走 `codex exec resume`，这会在新进程里跑一轮完整对话——耗时和 token 都按一整轮算，不是"改个设置"。
3. **同一个会话别开两个进程**，消息归属会乱。
4. **回复轮询上限 3 分钟**，超时手动点「读最近」。
5. **正在跑、还没落盘的当前轮**可能不在会话列表里。
6. 侧边栏 UI 只在本地手工加载验证过，没有跑自动化测试。

---

## License

MIT © 2026 A_hua

---

## 开机自启（launchd）

仓库里已生成好 `~/Library/LaunchAgents/com.gjr.annotation-bridge.plist`（`RunAtLoad` + `KeepAlive`）。装一次，以后开机自动在后台跑 bridge。

**在你自己的 Terminal 里执行**（DSH 沙箱里 `launchctl` 会被挡住）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gjr.annotation-bridge.plist
```

确认：

```bash
launchctl list | grep annotation-bridge   # 应有一行
curl -s 127.0.0.1:47391/health            # {"ok":true,...}
```

卸载：

```bash
launchctl bootout gui/$(id -u)/com.gjr.annotation-bridge
```

日志：`~/Library/Logs/annotation-bridge.log` 和 `.err.log`

## 多选元素

一次标注可以覆盖多个元素：进入拾取模式后**连续点击**要标注的元素，每个元素会打上编号；再点一次取消，**Enter** 结束。

投递出去长这样：

```markdown
1. 涉及 3 个元素：
   1) `div.card:nth-of-type(1)` — 卡片一
   2) `div.card:nth-of-type(2)` — 卡片二
   3) `div.card:nth-of-type(3)` — 卡片三
   备注：这三个卡片样式不一致
```

## 截图标注

截图会先打开编辑器，可以画**矩形 / 圈 / 箭头 / 文字**，选颜色、撤销，保存后才作为附件。

**图片怎么送到模型**：走「续跑」模式时，bridge 会把这些 PNG 用 `codex exec resume ... -i <png>` 传过去，
模型是**真的看到图**，不是读路径。排队模式没有图片通道，只会带上文件路径——面板会提示这一点。

## 桌面应用（不用开终端）

`~/Applications/` 下有两个 app，双击即用：

- **标注投递.app** —— 检查服务是否在跑，没跑就后台拉起，然后弹通知
- **停止标注投递.app** —— 停掉服务

服务用 `nohup` 脱离终端，关掉终端窗口不影响。日志在 `~/Library/Logs/annotation-bridge.log`。

## 采集：控制台 + 截图

- **控制台 + 网络**：`inject-console.js` 在**主世界**（`world: MAIN`）包装 `console.log/info/warn/error`、`fetch`、`XMLHttpRequest`，
  以及 `error` / `unhandledrejection`，通过 `postMessage` 转给隔离世界的内容脚本。网络记录含方法、URL、状态码、耗时，
  4xx/5xx 会带一段响应片段，并监听 `window.onerror` 与 `unhandledrejection`，保留最近 200 条。面板里点「抓取」会把日志存到 `~/.annotation-bridge/captures/<id>.json`，随标注一起投递（消息里带错误/warn 摘要）。
- **截图**：`chrome.tabs.captureVisibleTab` 抓当前可见区域，存成 PNG，路径写进投递消息。
- 两条都会作为「附件」挂在标注上，入队后清空。
