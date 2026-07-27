# weread-export

把微信读书里**你自己有权阅读的书**导出成 PDF，供个人离线阅读。

> 仅供个人使用。不要用它传播他人的书，也不要抓取不属于你的书架。部分出版方在书内
> 的《数字版权声明》中明确「仅供您个人使用，未经授权，不得进行传播」。

## 安装

克隆到本地，然后从本地目录装成全局命令。不涉及任何 npm 认证，也不会弹钥匙串：

```bash
git clone git@github.com:gwang-indoc/weread.git
cd weread

pnpm install        # 装依赖
pnpm build          # 编译到 dist/
npm i -g .          # 建立全局命令

weread-export login
```

`npm i -g .` 建的是**指向这个目录的符号链接**，不是副本。所以之后更新只要：

```bash
git pull && pnpm install && pnpm build
```

全局的 `weread-export` 立刻就是新版本，不用重新 `npm i -g`。

> **关于 `pnpm build`**：`package.json` 里的 `prepare` 脚本会自动编译，`pnpm install`
> 确实会执行它（安装输出里能看到 `tsc -p tsconfig.build.json`）。但新版 **npm** 的
> allow-scripts 机制会拦下 `prepare` 并只打一行警告，`dist/` 就不会生成、命令随即报错。
> 所以显式跑一次 build 最省心，无论用哪个包管理器都不会错。

不想装全局命令的话，在仓库里直接跑源码也一样（Node 会自己剥离类型）：

```bash
node src/cli.ts list
```

<details>
<summary>另一种方式：不 clone，直接从 GitHub 装（需要额外配置，一般不用）</summary>

仓库是私有的，而 npm 的 `hosted-git-info` 会认出 `github.com`，把 SSH URL "优化"成
codeload 的 HTTPS tarball 下载。私有仓库这一步需要认证，于是 git 调用
`credential.helper`（Homebrew 的 git 在 `/opt/homebrew/etc/gitconfig` 里默认配了
`osxkeychain`），macOS 就弹出钥匙串授权框。

绕开的办法是让 npm 认不出这是 GitHub —— 在 `~/.ssh/config` 加个别名：

```
Host github-weread
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
```

```bash
npm i -g git+ssh://git@github-weread/gwang-indoc/weread.git
```

这条路径下 npm 会老实地走 `git clone` + SSH（`--loglevel silly` 日志里 `codeload`
出现 0 次），且 git 依赖会正常执行 `prepare`，不需要手动 build。

补充：即使碰到那个钥匙串弹窗，点 Deny 安装**也会成功** —— HTTPS 失败后 npm 退回 SSH，
exit code 是 0。它是噪音，不是错误。

</details>

## 用法

```bash
weread-export login          # 微信扫码登录，会话存到 ~/.config/weread-export/
weread-export list           # 列出书架
weread-export                # 交互勾选要导出的书
weread-export 算法 马斯克      # 直接指定书名，跳过交互
weread-export status         # 状况面板（HTML，不联网、不需登录）
weread-export render 算法     # 只用缓存重新排版，不联网
```

### 状况面板

一本书要翻几百屏、几百 MB，跑完之后光看命令行输出很难知道到底落了什么。
`weread-export status` 生成一张本地 HTML 报告：

```bash
weread-export status              # 生成并打印 file:// 链接
weread-export status --open       # 顺手打开
weread-export status -o ~/x.html  # 换个输出位置
```

它**只读 `~/.cache/weread-export`**，所以和其他命令不同：不需要登录、不启动浏览器、
离线可用，**导出正在跑的时候也能用**（想看进度就再生成一次）。

面板上有四块：

- **缓存总量** —— 体积、屏数、页数、平均每页多少 KB；
- **逐本表格** —— 状态、已覆盖单元（meter）、屏数/页图/体积/更新时间；
- **条带** —— 每本书的阅读顺序，一格一屏，深浅交替表示换单元。
  **连续无缺口就说明线性走法没漏页** —— 这是它比一个百分比更有用的地方；
- **需要处理** —— 未抓完或旧格式缓存的书，以及该敲哪条命令。

展开条带下面的折叠还有「每个单元抓了多少屏」的柱状图和完整单元表格。

界面是从 4 个方案里挑出来的（表格 + 条带的组合），整套方案连同切换器留在
`prototype/dashboard-variants` 分支上作为原始资料。

### 导出选项

| 选项 | 说明 |
| --- | --- |
| `-o, --out <dir>` | 输出目录，默认 `out/` |
| `-f, --force` | 忽略缓存重新抓取 |
| `--scale <n>` | 抓取分辨率倍数，默认 2（见下） |
| `--max-screens <n>` | 最多翻多少屏（调试用） |
| `--headed` | 显示浏览器窗口 |

### `--scale` 怎么选

实测同一屏正文（《牛顿传》序言）：

| | 单栏像素 | 单页 | 一本约 400 页时 |
| --- | --- | --- | --- |
| `--scale 3` | 1179×2310 | 145–315 KB | ~400 MB |
| `--scale 2`（默认） | 786×1540 | 96–211 KB | **~270 MB** |

省约 **33%**（像素面积只有 44%，但 PNG 压中文正文时体积基本随边长走，不随面积）。
清晰度上：A5 实际尺寸和放大 2× 以内两者**肉眼无差**；放大到 4× 以上 `--scale 2`
才开始发虚。所以默认是 2 —— 读文字足够了。**会放大抠细节的书**（手稿、密集图表）
再显式传 `--scale 3`。`--scale` 只影响分辨率，**不改变排版和断行**（已核对过断行一致）。

同一本书换了 `--scale` 再续抓，会在同一份缓存里混入两种分辨率。这不会出错（排版时每栏
都缩放到页面大小），但命令会明确警告一次；想统一就加 `--force` 重抓。

### 浏览器要求

依赖 `playwright-core`，**不会**下载一百多 MB 的浏览器，所以安装很快。运行时按顺序复用
机器上已有的浏览器：**Chrome → Edge → Playwright 自带的 Chromium**。

三者都没有时会明确提示，任选一种解决：

```bash
# 装 Chrome / Edge（推荐），或者：
npx playwright install chromium
```

Node 需要 20.11 以上。

## 它是怎么工作的

微信读书的网页阅读器把正文**画在 `<canvas>` 上，DOM 里没有正文文字**（见
[ADR 0001](docs/adr/0001-capture-canvas-pixels.md)）。所以导出的方式是：

1. 用保存的会话打开阅读器，切换到浅色主题；
2. 读取目录（用于 PDF 里的目录页和书签）；
3. 从第一页开始**线性翻页到全书末尾**，把每屏左右两栏的 canvas 各截成一张图；
4. 每张图按内容哈希缓存到 `~/.cache/weread-export/<bookId>/`；
5. 用 Chromium 把缓存排版成 A5 PDF，每栏一页，带页码和章节书签。

抓取是**串行**的，每次翻页随机停 1–3 秒 —— 让流量像一个读得很快的人，而不是爬虫。

## 已知取舍

- **PDF 里没有文字层**：不能搜索、不能复制。正文是像素，这是 canvas 渲染的必然结果。
  缓存的是图片而不是成品 PDF，所以以后可以对缓存跑一次 OCR 补上文字层，不用重新抓。
- **没抓完就会说**：试读结束、未购买或中途中断时，PDF 末尾会有一页说明原因，命令以非零
  状态退出 —— 不会悄悄给你一个缺页的 PDF。重跑同一命令会从缓存续抓。
- **书签可能差一页**：节可以从页面中间开始，运行页眉本身就滞后一页（见
  [ADR 0002](docs/adr/0002-walk-the-book-linearly.md)），所以章节书签的位置和阅读器
  显示的一样不精确。
- **会改动阅读进度**：抓取就是在真实地翻页，你的「已读时长」和进度会增加。
- 导出期间会把阅读器切成浅色主题，结束后切回。

## 开发

```bash
pnpm install
pnpm test          # 离线单元测试，不需要登录
pnpm typecheck
pnpm build         # 编译到 dist/，npm 包发布的就是这个
node src/cli.ts list                      # 直接跑源码（Node 会剥离类型）
node scripts/dev-export.ts "书名" 8        # 只翻 8 屏，端到端验证
```

`dist/` 不进仓库，由 `prepare` 脚本在安装时编译。全局命令是指向本目录的符号链接，所以
`git pull && pnpm build` 之后立刻生效。

如果哪天想发到 npm：`npm login && npm publish`（`prepublishOnly` 会先跑 typecheck、测试
和构建）。本地验证打包结果：`npm pack` 然后 `npx ./weread-export-0.1.0.tgz --help`。

`src/` 各模块：`session` 登录与会话，`bookshelf` 书架与目录，`capture` canvas 截取与
翻页，`cache` 按屏缓存（内容哈希去重），`render` 排版 PDF，`export` 串起整本书，
`status` 状况面板，`cli` 命令行。

术语见 [CONTEXT.md](CONTEXT.md)。接手这个项目请先读
[docs/HANDOFF.md](docs/HANDOFF.md) —— 里面有踩过的坑、未决的决定，以及在真实账号上
操作的注意事项。
