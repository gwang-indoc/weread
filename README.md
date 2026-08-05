# weread-export

把微信读书里**你自己有权阅读的书**导出成 PDF 或 EPUB，供个人离线阅读。

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
weread-export render 算法     # 只用缓存重新排版 PDF，不联网
weread-export epub 算法       # 把缓存 OCR 成可重排 EPUB，不联网、不需登录（仅 macOS）
weread-export 算法 --format pdf    # 要 PDF（both = 两个都要）
```

**默认输出是 EPUB**，并且**抓取中断后会自己休息 5 分钟再继续**，直到抓完为止 —— 长书
不用守着。两者都可以改：`--format pdf`、`--retry-delay 0`。

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

### EPUB：可重排的文字版

PDF 是页面截图，在手机和电阅上不能重排、不能搜索、不能调字号，一本 300 屏的书三百多
MB。EPUB 走的是另一条路：**对已有缓存跑 OCR，重建段落**。

```bash
weread-export epub 牛顿传               # 从缓存生成 EPUB
weread-export epub 牛顿传 --author 迈克尔·怀特
weread-export epub 牛顿传 --force       # 忽略已有 OCR 结果，重新识别
```

它**只读缓存**，和 `status` 一样不联网、不需登录 —— 已经抓过的书可以直接离线转。
用的是 macOS 自带的 Vision 框架，所以**这条命令仅限 macOS**（抓取和 PDF 仍是跨平台的），
不需要装模型、不需要 API key，只需要 Xcode Command Line Tools 提供 `swiftc`。

实测（`--scale 2`）：

| | 页数 | 首次 OCR | 产物 | 相比 PDF |
| --- | --- | --- | --- | --- |
| 牛顿传（文字为主） | 36 | 27 秒 | 9,474 字 · 1 张图 · 0.3 MB | 11 MB 截图 |
| 达·芬奇手记（图文混排） | 598 | ~7 分钟 | 130,366 字 · 202 张图 · 26 MB | 360 MB 截图 |

OCR 结果按栏哈希缓存在 `ocr.json` 里，**重跑只要 1–2 秒**，改排版不用重新识别。

段落是从几何信息重建的：首行缩进、行宽是否满、行距，全部按每一栏自己的中位行高和
字宽校准（不用绝对阈值，所以换 `--scale` 或换书都不受影响）。跨栏、跨屏的段落会
接回去 —— 栏是微信读书的分页产物，不是书的结构。插图会从截图里裁出来嵌进 EPUB，
按阅读顺序排在正文之间。

**EPUB 末尾有一节「关于这个文件」**，写明这些内容是 OCR 出来的、哪些东西必然丢了，
并列出每一处低置信度的行供你抽查。它不给「准确率」——没有原文可比对，给分数等于暗示
其余部分已经核对过。这些取舍见
[ADR 0003](docs/adr/0003-ocr-the-cache-into-reflowable-text.md)。

### 导出选项

| 选项 | 说明 |
| --- | --- |
| `-o, --out <dir>` | 输出目录，默认 `out/` |
| `-f, --force` | 忽略缓存重新抓取（**会先删掉已有缓存**，见下） |
| `--yes` | 不询问，直接确认 `--force` 的删除 |
| `--format <fmt>` | `epub`（默认）、`pdf` 或 `both` |
| `--retry-delay <min>` | 中断后休息几分钟再继续，默认 5，`0` 表示不重试 |
| `--max-attempts <n>` | 最多尝试几次，默认 20 |
| `--scale <n>` | 抓取分辨率倍数，默认 2（见下） |
| `--max-screens <n>` | 最多翻多少屏（调试用） |
| `--headed` | 显示浏览器窗口 |

### `--force` 会删东西，所以会问一次

`--force` 不是「跳过缓存」，是**先把这本书的缓存目录整个删掉再从头抓**。抓取是串行的、
每屏 1–3 秒，一本抓完的书是几个小时的量，删掉只能照原速再走一遍 —— 所以它会先把要删的
书、已缓存多少页、目录在哪列出来，等你确认，默认答案是**否**。

缓存本来就是空的时候不会问：那种情况下 `--force` 什么都没删。

管道、cron、CI 里没有终端可以回答，这时它**不会**默认继续，而是直接退出（exit 1）并提示
加 `--yes`。`--yes` 就是事先替你回答「是」，非交互场景下要重抓必须显式写出来。

> `epub --force` 是另一回事：它丢掉的是 `ocr.json`，几分钟的识别结果，缓存本身不动，
> 所以不会问。

### 中断后自动续抓

一本长书一次翻完的概率不高：阅读器会卡住，翻页会没反应。默认行为是**休息 5 分钟、
重新加载阅读器、从上次的位置接着抓**，直到抓完。已抓的内容每 10 屏落盘一次，所以
Ctrl-C 也不会丢，重跑同一命令一样会续上。

停下来的条件有三个，都不是「等久一点就好」的情况：抓完了；试读结束/未购买（等五分钟
也不会变）；或者**连续两次尝试一屏新内容都没抓到** —— 说明卡的不是暂时的东西。
`--max-screens` 是你主动叫停的，也不会重试。

这里有个不明显的地方值得知道：**「书抓完了」和「翻页卡住了」在观测上完全一样** ——
都是点了下一页、同一屏像素又回来了。所以判断依据是**目录位置**：如果最后见到的页眉
离目录末尾还很远，那就是卡住，不是结束。没有这个判据的话，最常见的中断会被记成
「已完成」，自动续抓永远不会触发。

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
  要文字就用 `epub`——它对同一份缓存跑 OCR，不用重新抓。
- **EPUB 的文字是 OCR 出来的**，所以：**脚注内容没有**（标记画在页面上，注释本身在
  弹层里，抓取过程从未打开过它）；**斜体、加粗、字色丢失**；**会有错字，而且无法自检**
  ——没有原文可比对，只能把低置信度的行列出来给你抽查；**只加粗不加大的小标题会掉成
  普通段落**（OCR 看不到粗细，而按几何特征提升会把图注误判成标题，见
  [ADR 0003](docs/adr/0003-ocr-the-cache-into-reflowable-text.md)）。
  想要完整的排版和脚注标记位置，用 PDF。
- **没抓完就会说**：默认会先自动休息重试（见上）；仍然没抓完时，PDF 末尾会有一页、EPUB
  末尾的「关于这个文件」会有一段说明原因，命令以非零状态退出 —— 不会悄悄给你一个缺页的
  文件。重跑同一命令会从缓存续抓。
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
`status` 状况面板，`cli` 命令行。EPUB 这条链是 `ocr`（Vision 桥接，唯一不纯的部分，
内嵌一段 Swift 首次使用时编译）→ `text`（纯函数：合并行、重建段落、找插图）→
`epub`（组装文档）→ `zip`（手写 ZIP，因为 EPUB 要求 `mimetype` 不压缩且必须在最前）。

`text` 和 `epub`/`zip` 全是纯函数，所以 OCR 之后的每一个判断都能离线测试 —— `pnpm test`
里有针对真实 Vision 输出形状的用例。**注意 fixture 要给足行数**：所有规则都按栏内
中位行高自校准，只写两行的话，被测的那个标题自己就定义了「正常」。

术语见 [CONTEXT.md](CONTEXT.md)。接手这个项目请先读
[docs/HANDOFF.md](docs/HANDOFF.md) —— 里面有踩过的坑、未决的决定，以及在真实账号上
操作的注意事项。
