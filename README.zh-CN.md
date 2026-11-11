# kitespan

[English](README.md)

在你自己的机器上运行的 Claude Code CLI 浏览器界面，可以从笔记本电脑、手机或平板使用。

原汁原味的 Claude Code 体验。kitespan 不加 ACP 层，也不加它自己的提示词。

kitespan 通过 Claude Agent SDK 运行你 PATH 上的 `claude`，使用你自己的设置、hooks、MCP 服务器和模型选择。它不加自己的工具、参数或环境变量，也从不读取或转发你的 Claude 凭据。你的对话保存在 Claude Code 自己的记录（transcript）里。

## 为什么做它

kitespan 是一个个人项目。

我是每周通勤的“超级通勤族”：每周从洛杉矶飞到西雅图再飞回来，我希望在飞机上也能像在办公桌前一样轻松地工作。Claude Code 在我自己的机器上持续运行。在飞机上，我用笔记本通过机上 Wi-Fi，或者用手机跟上它——那里连接会断，标签页会休眠——连接恢复后再从中断的地方接着做。

Claude 自己的应用本可以做到这一点，但很多公司只允许通过云服务商的原始 API（例如 Bedrock）使用 Claude Code，无法使用这些应用，所以没办法同时在手机和笔记本上使用它。kitespan 就是我为此做的：在任何设备的浏览器里使用你已有的 Claude Code。

## 适合谁

kitespan 适合有 Claude Code、但用不了 Claude 自家应用的开发者：

- 你的公司通过云服务商、网关或公司自己的构建版本给你提供 Claude Code，而 Claude 应用对你不开放；
- 你通过模型服务商使用 Claude Code，但没有 Claude 订阅——许多中国开发者就是这样。

kitespan 不提供任何模型访问：它运行你已有的 `claude`，使用你自己的服务商和设置；它不承诺提供 Claude，也不会帮助任何人绕过服务商的地区限制。

## 现在能用什么

kitespan 只支持 Claude Code。下表每一行都由点击检查（`scripts/ui-check.ts`：在无头 Chrome 中运行真实页面，配合一个假的 Claude Code）验证；标明“实机测试”的行，也由使用真实 Claude Code 的可选实机测试验证（[test/live/README.md](test/live/README.md)）。

| 现在能用 | 验证方式 |
|---|---|
| 用你自己的 Claude Code 聊天：在项目文件夹里开始一个对话、发送消息，回复以流式显示，包括思考过程、工具调用及其差异（diff） | 点击检查、实机测试 |
| 权限、提问、计划和表单卡片 | 点击检查、实机测试 |
| 每个对话的模型、推理强度（effort）和权限模式；`!` 命令 | 点击检查、实机测试 |
| 文件：拖放、粘贴或选择；输入 `@` 提及文件 | 点击检查、实机测试 |
| 跨对话、文件、命令和消息正文的搜索 | 点击检查 |
| 一个对话在所有设备上同步：草稿保存在服务器上 | 点击检查、实机测试 |
| 连接断开、标签页休眠或网络很慢：对话从原处继续 | 点击检查、实机测试 |
| 在设置里更新和重启，在一轮结束时进行 | 点击检查、实机测试 |
| 终端面板，以及“在终端中打开”（它输入恢复或分叉命令，从不按回车） | 点击检查、实机测试 |
| 重命名、归档和删除 | 点击检查、实机测试 |
| 每个对话一个 worktree，以及每个环境的变量 | 点击检查、实机测试 |
| “立即发送”，用于正在等待的消息 | 点击检查、实机测试 |
| 旁聊（`/btw`） | 点击检查、实机测试 |
| 对话中的子代理（subagent）、工作流和后台任务；对话启动的后台会话 | 点击检查、实机测试 |
| 信任此文件夹 | 点击检查、实机测试 |
| 一轮中改动的文件及每个文件的差异，在笔记本和平板上 | 点击检查、实机测试 |
| 对话需要你时发出通知 | 点击检查、实机测试（笔记本上的 Chrome） |
| 手机和平板布局，以及主屏幕应用 | 点击检查 |
| 四种外观，每种都有浅色和深色 | 点击检查 |
| 浏览器面板：这台机器上一个由你和 Claude Code 共用的 Chrome（见下文“浏览器面板”） | 点击检查 |

| 还没有 | 说明 |
|---|---|
| 登录 | 当前版本没有（见下文“从其他设备访问”） |
| macOS | 尚未验证 |
| Homebrew | 尚未验证（推送后由发布工作流在 macOS 上运行） |
| iPhone 主屏幕应用中的通知 | 尚未验证 |
| Windows | 不支持 |
| 编辑、重试和回退消息 | 以后 |
| 针对差异中某一行的评论，以及文件编辑器 | 以后 |
| 对话的分组、置顶和导出 | 以后 |
| 定时任务 | 以后 |
| Pull request 和 CI 状态 | 以后 |

## 环境要求

- Linux。macOS 尚未验证；不支持 Windows。
- Bun 1.3.14 或更高版本，作为 `bun` 在你的 PATH 上（[Bun 的安装页面](https://bun.com/docs/installation)）。kitespan 从不替你安装 Bun；用 Homebrew 安装 kitespan 时，Homebrew 会一并安装它。
- Claude Code 2.1.296 或更高版本，已登录，作为 `claude` 在你的 PATH 上。kitespan 只运行这一个。
- 从源码安装时还需要 git。

## 安装

任选一种方式。每种都免费，都装在你自己的文件夹里，都不需要 sudo。

### 用安装脚本

```sh
curl -fsSL https://github.com/wannaFlyKa/kitespan/releases/latest/download/install.sh | sh
```

它先检查，所有检查通过之前不做任何改动：Linux 或 macOS、`curl` 或 `wget`、`tar`、`gzip`、`sha256sum` 或 `shasum`，以及 Bun 1.3.14 或更高版本。它也会查找你的 `claude`，缺少或低于 2.1.296 时会提示一行，安装照常继续。然后它下载最新版本及其 `SHA256SUMS`，校验压缩包的 SHA-256，解压到 `~/.local/share/kitespan/versions/<version>/`（或 `$XDG_DATA_HOME/kitespan/versions/`），按锁文件安装依赖包（`bun install --frozen-lockfile --omit=optional --production`），构建页面，全部完成后才让 `~/.local/bin/kitespan` 启动它。它也会保留上一个版本。它从不修改你的 shell 启动文件：`~/.local/bin` 不在 PATH 上时，它会打印需要添加的那一行。

想在运行前先读一读脚本：从最新版本下载 `install.sh` 和 `SHA256SUMS`，把 `sha256sum install.sh`（macOS 上用 `shasum -a 256 install.sh`）的结果与 `SHA256SUMS` 里它的那一行比对，然后运行 `sh install.sh`。每个版本的文件都带有构建来源证明（build provenance attestation）：`gh attestation verify kitespan-<version>.tar.gz --repo wannaFlyKa/kitespan`。

| 命令 | 作用 |
|---|---|
| `KITESPAN_VERSION=0.1.0 sh install.sh` | 安装指定版本而不是最新版本（也用于退回到旧版本） |
| `sh install.sh --list` | 列出已安装的版本，以及 `kitespan` 启动的是哪一个 |
| `sh install.sh --uninstall` | 删除 `~/.local/bin/kitespan` 和已安装的版本；你的对话、设置和配置都会保留 |

通过管道运行时，选项写在 `sh -s --` 之后，例如 `curl -fsSL https://github.com/wannaFlyKa/kitespan/releases/latest/download/install.sh | sh -s -- --uninstall`。

### 用 Homebrew

```sh
brew install wannaFlyKa/tap/kitespan
```

它也会从 Homebrew 安装 Bun。`brew uninstall kitespan` 会删除 kitespan；你的对话、设置和配置都会保留。

### 从源码安装

```sh
git clone <this repository> kitespan
cd kitespan
bun install --frozen-lockfile --omit=optional
bun run build
```

`--omit=optional` 让 SDK 自带的 Claude Code 二进制文件不被安装，因此只运行你自己的 `claude`。Claude Agent SDK 属于 Anthropic，适用它自己的条款（<https://code.claude.com/docs/en/legal-and-compliance>）；`bun install` 从 npm 获取它，本仓库不包含它。上面每种安装方式都以同样的方式获取它。

## 启动

```sh
kitespan
```

从源码安装时用 `bin/kitespan`。它只监听 127.0.0.1，端口 7940（用 `--port <port>` 换一个端口）。在同一台机器的浏览器里打开 http://127.0.0.1:7940，或者从其他设备通过你信任的转发打开（见下文）。`kitespan --help` 列出所有选项，`kitespan --version` 打印版本号。按 Ctrl+C 会停止服务器，以及每个打开的对话里的 Claude Code。

在 Bun 启动之前，`bin/kitespan` 会去掉启动它的 Claude Code 会话的变量；在 Claude Desktop 主机上，还会去掉该主机的凭据；Bun 也不会加载任何 `.env` 文件。你自己的设置行写在 `~/.config/kitespan/start-env` 里；`bin/kitespan` 开头的注释说明了它们的格式。

## 更新

| 安装方式 | 如何更新 |
|---|---|
| 安装脚本 | “设置 > 关于 > 更新”（Settings > About > Update），或再运行一次安装命令 |
| Homebrew | `brew upgrade kitespan` |
| 从源码安装 | “设置 > 关于 > 更新”，或 `bin/update.sh` |

然后重启 kitespan 以运行新版本：“设置 > 关于 > 重启”（Settings > About > Restart），或 `kitespan restart`（从源码安装时用 `bin/kitespan restart`）。`brew upgrade` 之后要马上重启：Homebrew 会删除旧版本的文件夹。

用安装脚本安装的 kitespan，更新的方式和安装一样：新版本装在正在运行的版本旁边，每一步都完成后 `kitespan` 才启动它；正在运行的 kitespan 会一直运行，直到你重启它。源码仓库的更新会拒绝有本地改动的仓库；然后从 origin 获取并只做快进（从不合并，也从不覆盖 origin 开始跟踪的、你自己被忽略的文件），用 `--frozen-lockfile --omit=optional` 按锁文件安装，再构建页面。任何一步失败就停止。

“设置 > 关于 > 检查更新”（Check for updates）可以每天（Daily，默认）、每 3 小时（Every 3 hours）或手动（Manually，只在你按“立即检查”时）查找新版本。源码仓库询问它的 origin（`git ls-remote`）；用安装脚本安装的 kitespan 从 GitHub 下载最新版本的 `SHA256SUMS`，这个请求不包含版本号、机器名或账号。用 Homebrew 安装的 kitespan 从不检查：由 `brew outdated` 来做。kitespan 从不自己更新，也从不自己重启。

## 文件

kitespan 把状态保存在 `~/.local/state/kitespan/`（或 `$XDG_STATE_HOME/kitespan/`）：对话列表、草稿、它的设置，以及从不记录你或 Claude 所写内容的日志。你自己的配置在 `~/.config/kitespan/`（或 `$XDG_CONFIG_HOME/kitespan/`）：`adapters.json` 和 `start-env`，kitespan 只读取、从不写入它们。它正在创建的 worktree 的记录在 `~/.local/share/kitespan/`（或 `$XDG_DATA_HOME/kitespan/`）。用安装脚本安装时，每个版本都在 `~/.local/share/kitespan/versions/` 里，`~/.local/share/kitespan/current` 指向 `kitespan` 启动的那个版本。文件夹权限为 0700，文件为 0600。

配置文件夹里的 `browser.json` 指定浏览器程序及其端口；kitespan 只读取、从不写入它：

```json
{ "v": 1, "chrome": "/usr/bin/google-chrome-stable", "port": 9340 }
```

没有这个文件时，kitespan 使用你 `PATH` 中的 Google Chrome 或 Chromium，端口为 9340。浏览器的配置文件（profile）连同你的登录状态，位于 `~/.local/state/kitespan/browser/`。备份状态文件夹也会带走你的登录状态。

## 从其他设备访问

kitespan 当前版本没有登录功能：任何能打开它页面的人，都能以你的身份运行 Claude Code；你要为自己从其他设备连接它的方式负责。

任何能打开 kitespan 页面的人，也都能使用它的浏览器面板，连同你的登录状态（见下文“浏览器面板”）。

kitespan 只接受来自它自己端口上的 `127.0.0.1`、`localhost` 或 `[::1]` 的页面，以及你允许的来源（origin）。其他任何来源都会得到 403，因此其他网站的页面无法访问它。

| 访问方式 | 需要允许什么 |
|---|---|
| `ssh -L 7940:127.0.0.1:7940 <host>`，然后打开 `http://localhost:7940` | 不需要 |
| `ssh -L 8080:127.0.0.1:7940 <host>`，然后打开 `http://localhost:8080` | `--origin http://localhost:8080` |
| Tailscale Serve：在主机上运行 `tailscale serve 7940`，然后打开 `https://<machine>.<tailnet>.ts.net` | `--origin https://<machine>.<tailnet>.ts.net` |
| Cloudflare Tunnel 指向 `http://127.0.0.1:7940`，前面加 Cloudflare Access | `--origin https://kitespan.example.com`（它的公开主机名） |
| 其他反向代理 | `--origin` 加上浏览器显示的确切来源；端口不是 443 时要带上端口 |

例如：

```sh
bin/kitespan --origin https://box.tail1234.ts.net
```

启动时，kitespan 会打印它在自身来源之外允许的每个来源，以及每个来源从哪里来。`--origin` 不会被保存：它一直有效，直到你停止 kitespan；从设置重启、`bin/kitespan restart` 或更新后的重启都会保留它。要去掉它，先停止 kitespan，再不带这个参数重新启动。要长期保留一个来源，把它写进 `~/.config/kitespan/adapters.json`（或 `$XDG_CONFIG_HOME/kitespan/adapters.json`，一个属于你自己的文件，权限 0600，kitespan 从不写入）的 `access.origins`：

```json
{ "v": 1, "access": { "origins": ["https://kitespan.example.com"] } }
```

kitespan 在启动时读取这个文件，所以修改后要重启它。转发必须原样传递浏览器的 `Origin` 头；它可以把公开的名字或 `localhost:<port>` 作为 Host 传递。任何离开你自己机器的转发，前面都要加一道访问控制（Cloudflare Access，或你 tailnet 自己的访问规则）。

上面的访问方式是各产品自己文档中的例子，不是 kitespan 做的检查：
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)、
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) 和
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

## 浏览器面板

浏览器面板显示这台机器上一个共用的 Chrome，你和 Claude Code 都使用它。它有自己的配置文件（profile），所以你登录过的网站会保持登录，对 Claude 也一样。任何能打开 kitespan 页面的人，都能使用这个浏览器，连同你的登录状态。

只有在你按下“启动浏览器”（Start browser）之后，kitespan 才会启动这个浏览器。kitespan 重启时（在设置里、用 `bin/kitespan restart` 或更新后）浏览器继续运行，标签页也都保留。你退出 kitespan 时，它也会停止浏览器；之后浏览器保持关闭，直到你再次按下“启动浏览器”。kitespan 崩溃时无法停止它：浏览器会继续运行，连同你的登录状态和打开的调试端口，直到你在“设置 > 浏览器”里按下“停止浏览器”（Stop browser），或者机器关机。离开一台共用的机器之前，请先停止它。

“设置 > 浏览器”中的“清除浏览数据”（Clear browsing data）会停止浏览器，删除它的整个配置文件（登录状态、Cookie、历史记录、网站数据和缓存），然后不带任何标签页重新启动它。下载的文件会保留，直到你删除它们。

要让 Claude Code 使用同一个浏览器，请在你的 Claude Code 配置中添加一次 Playwright MCP 服务器：

```sh
claude mcp add -s user playwright -- npx @playwright/mcp@0.0.84 --cdp-endpoint http://127.0.0.1:9340 --no-webmcp --output-dir ~/.cache/playwright-mcp-output
```

kitespan 从不更改你的 Claude Code 配置。“Claude 正在操作”（Claude is acting）标记只对名为 `playwright` 的服务器亮起。“设置 > 浏览器”会显示适用于当前端口的这条命令。

Playwright MCP 服务器的 `browser_run_code_unsafe` 工具会以你的身份、在浏览器之外、在这台机器上运行任意代码。请像对待一条 shell 命令那样对待使用它的请求，或者在 Claude Code 的权限设置中拒绝这个工具：为 `mcp__playwright__browser_run_code_unsafe` 添加一条拒绝规则，你可以用 Claude Code 的 `/permissions` 添加。

Claude Code 使用它的浏览器工具选中的标签页，这可能是你自己的标签页。Claude 使用的每个标签页都会出现在面板的标签页中；如果面板还停留在浏览器启动时的空白标签页上，它会跟随 Claude 切换到那个标签页。请先让 Claude 打开它自己的标签页，例如：用 browser_tabs 打开一个新标签页，然后在那里操作。

如果你在 Claude 操作同一个标签页时，在面板里选择了一个文件，Claude 的浏览器工具随后会报告有一个打开的文件选择器。Claude 用不带路径的 browser_file_upload 清除它。

Chrome 的调试端口（127.0.0.1:9340）没有密码：这台机器上的任何程序都能控制这个共用的浏览器。绝不要转发这个端口。

屏幕阅读器无法通过面板读取网页；面板里的网页是一张图片。

## 开发

```sh
bun install --frozen-lockfile --omit=optional
bun run ci
bin/kitespan dev
```

`bun run ci` 运行 CI 的 check 任务所运行的内容：两项类型检查、测试、页面构建和公开清洁审计（public-clean audit）。测试使用一个假的 Claude Code，从不启动真实的 `claude`。实机测试是可选的：`bun run test:live` 会用你自己的 Claude Code 运行真实的对话轮次（[test/live/README.md](test/live/README.md)）。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。每个提交都要签署（`git commit -s`）。

## 安全

报告漏洞见 [SECURITY.md](SECURITY.md)。

## 许可证

Apache-2.0：见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。

## 商标

Claude 和 Claude Code 是 Anthropic, PBC 的商标。kitespan 是独立的个人项目，并非由 Anthropic 或任何雇主制作或认可；它提到 Claude Code 只是为了说明它运行的是什么。
