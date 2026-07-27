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
weread-export render 算法     # 只用缓存重新排版，不联网
```

### 浏览器要求

依赖 `playwright-core`，**不会**下载一百多 MB 的浏览器，所以安装很快。运行时按顺序复用
机器上已有的浏览器：**Chrome → Edge → Playwright 自带的 Chromium**。

三者都没有时会明确提示，任选一种解决：

```bash
# 装 Chrome / Edge（推荐），或者：
npx playwright install chromium
```

Node 需要 20.11 以上。

常用选项：

| 选项 | 说明 |
| --- | --- |
| `-o, --out <dir>` | 输出目录，默认 `out/` |
| `-f, --force` | 忽略缓存重新抓取 |
| `--scale <n>` | 抓取分辨率倍数，默认 3（越大越清晰、文件越大） |
| `--chapters 12,13` | 只导出指定目录序号 |
| `--headed` | 显示浏览器窗口 |

## 它是怎么工作的

微信读书的网页阅读器把正文**画在 `<canvas>` 上，DOM 里没有正文文字**（见
[ADR 0001](docs/adr/0001-capture-canvas-pixels.md)）。所以导出的方式是：

1. 用保存的会话打开阅读器，切换到浅色主题；
2. 读取目录（支持 分卷 / 章 / 节 的层级）；
3. 逐章翻页，把左右两栏的 canvas 各截成一张图；
4. 每张图缓存到 `~/.cache/weread-export/<bookId>/`；
5. 用 Chromium 把缓存排版成 A5 PDF，每栏一页，带页码和章节书签。

抓取是**串行**的，每次翻页随机停 1–3 秒 —— 让流量像一个读得很快的人，而不是爬虫。

## 已知取舍

- **PDF 里没有文字层**：不能搜索、不能复制。正文是像素，这是 canvas 渲染的必然结果。
  缓存的是图片而不是成品 PDF，所以以后可以对缓存跑一次 OCR 补上文字层，不用重新抓。
- **未授权的章节**（试读结束、未购买）会在 PDF 中生成一个醒目的占位页，并且命令以
  非零状态退出 —— 不会悄悄给你一个缺页的 PDF。
- **会改动阅读进度**：抓取就是在真实地翻页，你的「已读时长」和进度会增加。
- 导出期间会把阅读器切成浅色主题，结束后切回。

## 开发

```bash
pnpm install
pnpm test          # 离线单元测试，不需要登录
pnpm typecheck
pnpm build         # 编译到 dist/，npm 包发布的就是这个
node src/cli.ts list                      # 直接跑源码（Node 会剥离类型）
node scripts/dev-export.ts "书名" 12 4     # 抓 1 章的前 4 屏，端到端验证
```

`dist/` 不进仓库，由 `prepare` 脚本在安装时编译 —— 这也是 `npx github:` 能直接跑的原因。
改完代码 `git push` 即生效，使用者重新 `npx` 就拿到新版本，不需要发版。

如果哪天想发到 npm：`npm login && npm publish`（`prepublishOnly` 会先跑 typecheck、测试
和构建）。本地验证打包结果：`npm pack` 然后 `npx ./weread-export-0.1.0.tgz --help`。

`src/` 各模块：`session` 登录与会话，`bookshelf` 书架与目录，`capture` canvas 截取与
翻页，`cache` 分章缓存，`render` 排版 PDF，`export` 串起整本书，`cli` 命令行。

术语见 [CONTEXT.md](CONTEXT.md)。
