# 梦之城工作间

公司内部工作台，线上地址 **https://work.lhdreamcity.com**。

一句话说清它是干什么的：**一个网页，让同事记下每天做了什么、找到公司资料和工具入口、把文件丢进公司资产库。**

- 不用装客户端，浏览器打开就能用
- 用企业微信扫码登录，姓名由企业微信确认
- 同事不需要会 Git，也不需要知道文件放在哪台机器上

---

## 一、业务域

工作台看着是一个站点，左侧导航只分三段：**工作记录 / 库 / 设置**。

> 早期版本按「资料 / 库 / 数据 / 组织 / 应用 / Skill」分栏 —— 那是拿**内容类型**当导航层级，栏目只会越加越多。
> 现在收敛成**一个内容入口**：「资料库」。其余全部下沉为它内部的分组或子视图。

### 1. 工作记录（谁在做什么）

| 页面 | 能力 |
|---|---|
| 首页 | 个人驾驶舱：今日工作、我的概览、工作数据（工时柱状 + 进度分布）、需要关注的阻碍、团队最近进展、常用应用、近期记录 |
| 今日记录 | 填日期、姓名，逐条写工作事项（内容 / 进度 / 耗时 / 阻碍），另有「问题与下一步计划」选填区 |
| 我的历史 | 本月统计（天数 / 事项数 / 工时）、按状态筛选、搜索、最近记录 |
| 团队记录 | 看同事的记录。**已完成的记录全员可见，草稿只有本人可见** |

> 「数据」不再是独立页面 —— 那两个图表已并入首页的「工作数据」模块。

### 2. 资料库（东西在哪 + 东西本身）

**唯一的资料入口**，Finder 式：左侧源列表 / 中间列表 / 右侧预览。

左栏分四段，对应四类内容（**空分组不占位**：计数为 0 的分组/署名不渲染，避免整列被"全是 0"撑满）：

| 分组 | 内容 | 数据来源 |
|---|---|---|
| 位置 | 全部文件、最近上传、云端大文件（无云端大文件时不显示） | 仓库文件树 + COS 索引 |
| 入库登记 | 公司资料、应用、组织、Skill——**只列有条目的**；四条全空时压成一行「＋ 登记第一个入口」 | `/api/directory` 的登记条目（**数据库记录，不是文件**） |
| 署名标签 | 按署名筛选目录、文件与云端条目，每个标签一个颜色；只列真的挂着内容的署名 | 仓库 `_meta/authors.md` |
| 目录 | **库根的一级目录**：projects / knowledge / workflows / media 是默认四项，其余由「新建文件夹 → 库根目录」自建 | Gitee 仓库的真实目录树（目录名保持英文，界面切中文标签） |

| 能力 | 说明 |
|---|---|
| 浏览 | 列表 / 图标两种视图，全库搜索（文件名 + 登记条目一起搜） |
| 预览 | 宽屏常驻右栏、窄屏居中弹层；图片直接看；Markdown 渲染（Obsidian 观感）；文本类看原文；**云端大文件的视频 / 音频 / 图片 / PDF 也能内联播放或查看**（服务端重写响应头绕开 COS 的强制下载，支持拖进度条） |
| 上传 | 拖拽文件、拖拽**整个文件夹**、或按钮选文件 / 选文件夹，目录层级原样保留 |
| 整理 | 新建文件夹（**位置可选**：库根 → 新建一级目录，或任一级目录 → 建子目录）、重命名、移动 |
| 署名 | 上传时贴署名标签（谁传的）；**目录与文件都能署名**，署名跟着移动走，一经署名不可改 |
| 复制 / 剪切 / 粘贴 | 快捷键 `Ctrl+C / X / V`（Mac 用 `⌘`），配合 `Ctrl+A` 全选、`Esc` 取消选择；也可右键或点工具条。复制是复制（原件留着、可重复粘贴），剪切是移动（粘贴后原位消失）。**同一文件夹内不允许重名**，不做覆盖也不自动改名；跨文件夹允许同内容 |
| 下载 | 两条通道：**云端大文件走 COS 签名直链**（浏览器直连，不吃本站带宽，实测 6.3 MB/s）；仓库内文件与文件夹走本站（单文件直传，文件夹**流式打包 zip**，含空目录，实测 0.68 MB/s）。入口：预览面板「⬇ 下载」、行菜单、工具条「⬇ 下载」、空白右键「下载当前文件夹」、`Ctrl/⌘+S`。文件夹与多选下载前先弹**体积 + 预计耗时**（按实测吞吐算），超过 80MB 交给浏览器原生下载 |
| 异步打包 | 大包（≥8MB）默认走**后台打包 → 传云 → 给直链**：任务在服务端跑，关掉页面也继续，完成后拿到的链接直连 COS（7 天有效）；同一份内容（按路径 + 大小 + mtime 指纹）再下**不重打不重传**，秒回直链。进度分「打包 / 上传 / 已就绪」三段，可取消（断掉上传，COS 不留半截对象）。工具条「⏳ 打包中 / ⬇ 已打包」是入口，任务记录落 `/data/downloads` |
| 不做 | **没有删除**。接口层不提供任何删除/清空能力，避免误操作 |

### 3. 设置

| 页面 | 能力 |
|---|---|
| 入口管理 | 增删改上面四类登记条目（资料 / 应用 / 组织 / Skill） |
| 企业微信连接 | 登录态、同步状态与智能表格入口 |

---

## 二、架构

```
                        ┌──────────────────────────────┐
   浏览器  ──443──►  Caddy  ─┬─ /api/library/*, /api/upload* ─►  library:3001
                        │    ├─ /api/*, /auth/*              ─►  app:3000
                        │    └─ 其余（静态）                  ─►  /srv
                        │
                        │    ┌─ /workspace ◄── Gitee 克隆仓 dreamcity_workspace
                        └──► │   library 服务
                             └─ 腾讯云 COS（视频 / 大文件）

                              ┌─ SQLite（docker 卷 app_data）
                             │   app 服务 ──┴─ 企业微信智能表格（异步同步）
```

三个容器，各管一段，互不重启：

| 容器 | 镜像 | 端口 | 职责 | 代码 |
|---|---|---|---|---|
| `workbench-deploy-caddy-1` | caddy:2 | 80 / 443 | TLS、路由分发、静态文件 | `Caddyfile` |
| `workbench-deploy-app-1` | node:24-slim | 3000（内网） | 登录、工作记录、目录登记、表格同步 | `backend/` |
| `workbench-deploy-library-1` | node:24 | 3001（内网） | 库：目录树 / 预览 / 上传 / 文件操作 | `library/` |

**为什么拆成两个服务**：库要往 Git 仓库写东西，还要跑 `git` 命令和连 COS，风险面和 app 完全不同。拆开之后：库挂了只有「库」页受影响，记录功能照常；改库的代码重启 library 容器，app 和 caddy 一动不动，**用户不会掉线**。

**两个服务共用一套登录态**：library 挂载同一个 `app_data` 卷，只读直读 `sessions` 表，不另造一套认证。所以企业微信登录一次，两边都认。

---

## 三、存储分层

东西不都放在一处，按重量分三层。

| 层 | 放什么 | 实体在哪 | 进 Git 吗 |
|---|---|---|---|
| **L1 文本真源** | 文档、SOP、知识条目、代码 | Gitee 私有仓 | 是 |
| **L2 中等资产** | 图片、PPT、表格（<50MB） | L1 仓 + 库页视图 | 是 |
| **L3 重资产** | 视频、设计源文件、≥50MB | 腾讯云 COS | 否，只在索引里登记 |

**规则**：L1 是真源，L2 由 L1 承载体，L3 只在索引里留位置。

**上传时的分流**（库服务自动判断，用户不用管）：

| 文件类型 | 去哪 | 怎么落地 |
|---|---|---|
| 文档 / 图片 / 普通文件，且 < 50MB | Gitee 仓库 | 落盘 → `.md` 自动补署名 → `git commit --author` → push |
| 视频（mp4/mov/avi…）、任何 ≥ 50MB 的文件 | 腾讯云 COS | 走对象存储，在 `media/manifest.yaml` 登记一条 |

**两个仓分开放**：

| 仓 | 内容 | 远端 |
|---|---|---|
| 本仓（代码） | 工作台本身的源码 | GitHub `lhDreamCity/official_workspace` + Gitee `dreamcity_work` |
| `dreamcity_workspace`（内容） | 同事上传的文档、素材 | Gitee `piloting-the-city-of-dreams/dreamcity_workspace` |

**为什么不把内容也塞本仓**：内容会一直长，代码得保持干净。分开之后，代码仓 clone 一次几十 KB，内容仓可以慢慢涨。另外内容仓同事能通过库页直接写，不需要碰代码。

---

## 四、代码目录

```
dreamcity_work/
├─ README.md                    ← 本文件
├─ compose.yaml                 三个服务的编排
├─ Caddyfile                    路由规则
├─ deploy.sh                    一键部署（零停机）
├─ app.env                      主服务环境变量（含密钥，不进 Git）
├─ library.env                  库服务环境变量（含密钥，不进 Git）
├─ library.env.example          环境变量模板
├─ _来源与部署说明.md            拉取来源、部署踩坑、接口细节（运维手册）
│
├─ backend/                     主服务（app，端口 3000）
│  ├─ server.mjs                入口：路由 / 会话 / 记录校验
│  ├─ wecom.mjs                 企业微信客户端（登录、通讯录、token 缓存）
│  ├─ smartsheet.mjs            智能表格同步（带重试队列）
│  ├─ directory.mjs             公司入口登记（应用 / 资料 / 组织 / Skill）
│  ├─ configure-wecom.mjs       一次性配置脚本
│  └─ setup-smartsheet.mjs      一次性建表脚本
│
├─ library/                     库服务（library，端口 3001）
│  ├─ server.mjs                入口：复用 app 的登录态
│  ├─ library.mjs               核心：目录树 / 上传 / 文件操作 / git 提交 / 下载任务
│  ├─ zip.mjs                   流式 ZIP 打包（零依赖，数据描述符写法）
│  └─ cos.mjs                   腾讯云 COS 存取（签名、对象 key 规则、流式 PUT）
│
├─ public/                      前端（纯静态，无构建步骤）
│  ├─ index.html                页面骨架（压缩成 7 行）
│  ├─ bootstrap.js              启动器：认证 → 拉数据 → 依次加载模块
│  ├─ *.js                      8 个功能模块（见第八节）
│  ├─ *.css                     样式
│  ├─ vendor/                   Markdown 渲染依赖（marked / DOMPurify / highlight.js）
│  └─ logo.png / hero-banner.png
│
├─ keys/                        Gitee 部署私钥（不进 Git，只在服务器上）
└─ backup-*/                    历次改动留档（不进 Git）
```

**后端零依赖**：没有 `package.json`，没有 `node_modules`，没有构建步骤。所有 `.mjs` 只用 Node 内置模块和互相引用。**目录即产物**，改完文件容器直接读到。

---

## 五、跑起来 / 改代码 / 部署

### 部署

```bash
bash deploy.sh
```

脚本干四件事：打包（排除密钥、git、历史备份）→ 上传 → 远端先备份 → 解包 → library 服务等健康 → Caddy 配置 `validate` 后热加载。

**改一行代码要不要重启，看改的是哪：**

| 改了什么 | 怎么生效 | 影响 |
|---|---|---|
| `public/` 下的前端文件 | 即时生效，浏览器刷新 | 无 |
| `backend/` 下的主服务代码 | `docker compose restart app` | 几秒，期间记录功能不可用 |
| `library/` 下的库服务代码 | `docker compose restart library` | 几秒，只有「库」页受影响 |
| `Caddyfile` | 走 Admin API 热加载（见运维手册） | 无 |

`deploy.sh` 不会自动重启 app 和 library —— 只传文件。**改后端代码要自己补一条重启命令**，否则新代码不生效（挂载是实时的，但进程已经把旧代码读进内存了）。

### 前端改完必做：更新缓存指纹

前端资源带 `?v=` 指纹，链式三层：`index.html` → `bootstrap.js` → 各模块。改了下层必须同步更新上层，否则浏览器继续用缓存里的旧文件。

```bash
sed -i "s|library-ui.js?v=[a-f0-9]*|library-ui.js?v=$(md5sum public/library-ui.js | cut -c1-12)|" public/bootstrap.js
sed -i "s|library.css?v=[a-f0-9]*|library.css?v=$(md5sum public/library.css | cut -c1-12)|" public/index.html
sed -i "s|bootstrap.js?v=[a-f0-9]*|bootstrap.js?v=$(md5sum public/bootstrap.js | cut -c1-12)|" public/index.html   # 这步最容易漏
```

**指纹口径**：`md5(文件)` 前 12 位。`index.html` 与 `bootstrap.js` 里引用的**每一个** `?v=` 都要对得上，包括 `style.css` / `focus.css` / `auth.css` 这三个以前没指纹的。

**自检**（部署前跑一遍，有输出就说明有漏的）：

```bash
node -e 'const fs=require("fs"),c=require("crypto");const m=f=>c.createHash("md5").update(fs.readFileSync("public/"+f)).digest("hex").slice(0,12);for(const h of ["bootstrap.js","index.html"]){for(const x of fs.readFileSync("public/"+h,"utf8").matchAll(/([\w./-]+\.(?:js|css|png|svg))\?v=([a-f0-9]{8,})/g)){if(fs.existsSync("public/"+x[1])&&m(x[1])!==x[2])console.log("STALE",h,x[1],x[2],"->",m(x[1]));}}'
```

> 2026-10-29 清过一轮：当时 `logo.png`、`journal-ui.js`、`interface.css`、`hub.css`、`journal-ui.css` 的指纹都过期，`style.css` / `focus.css` / `auth.css` 三个压根没指纹。

### 运维手册

部署踩过的坑、两个服务的接口细节、前端指纹规范、Markdown 渲染说明，都在 **`_来源与部署说明.md`**。改库服务之前先读第七节。

---

## 六、登录与权限

### 登录

走**企业微信 OAuth**（`AUTH_PROVIDER=wecom`，代码同时兼容飞书）。员工姓名由企业微信返回，不是自己填的。

登录后拿一个 session cookie，服务端 `sessions` 表里存的是 `sha256(cookie 明文)` —— 明文不落库。

### 权限

| 规则 | 说明 |
|---|---|
| 已完成记录 | 全员可见 |
| 草稿 | 仅本人可见 |
| 记录修改 / 删除 | 只有本人能操作 |
| 库文件 | 全员可读可上传，**谁都不能删** |
| 署名 | 上传时贴，**贴上之后不可修改** |

**共用账号的现实**：公司的 WorkBuddy 只有一个账号，Gitee 也只有一个公司账号，所以**平台层没有身份**。权责靠两层约定：

1. 提交署名用 `--author "姓名 <邮箱>"`，依据是花名册 `roster.md`
2. 库页的署名标签（Jole7 / 大咖浩 / VD / Alex）落到 `_meta/authors.md`

### 写操作保护

所有非 GET 请求都要带 `Origin` + `X-CSRF-Token`，两者都对上才放行。CSRF token 在登录时随 session 一起下发。

---

## 七、接口清单

### 主服务（app，3000）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康探针 |
| GET | `/api/auth-config` | 登录方式（企业微信 / 飞书） |
| GET | `/auth/{provider}/login` | 发起 OAuth |
| GET | `/auth/{provider}/callback` | OAuth 回调，建 session |
| GET | `/api/me` | 当前用户 + CSRF token |
| POST | `/api/logout` | 退出 |
| GET / POST / DELETE | `/api/records`、`/api/records/{id}` | 工作记录的读写删（带版本号做并发控制） |
| GET | `/api/team-records` | 团队记录（只返回已完成，分页） |
| GET | `/api/sync-status` | 智能表格同步状态 |
| * | `/api/directory/*` | 公司入口登记（应用 / 资料 / 组织 / Skill） |

### 库服务（library，3001）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/library/health` | 健康探针 |
| GET | `/api/library/tree` | 目录树 + 署名登记 + 下拉选项（Gitee 仓与 COS 条目合并成一张视图） |
| GET | `/api/library/file` | 文件预览（文本 / 图片） |
| GET | `/api/library/cos` | 换云端链接：默认预览用（`direct` 签名直链或本站代理），`dl=1` 返回附件直链 |
| GET | `/api/library/cos/stream` | 代理转发云端对象（重写响应头 + 透传 Range，视频可拖进度条） |
| GET | `/api/library/download` | 仓库内单文件下载（`Content-Disposition: attachment`，中文名走 `filename*`） |
| GET | `/api/library/zip` | 文件夹 / 多选打包下载；`?path=a&path=b`，加 `plan=1` 只返回体积与预计耗时 |
| POST | `/api/library/zipjob` | 建后台打包任务（body `{paths}`）；同一份内容命中已有任务时返回 `hit:true` 与旧任务 |
| GET | `/api/library/zipjob?id=` | 任务进度（`status/pct/phase`），就绪后带 COS 直链（每次现签，7 天有效） |
| GET | `/api/library/zipjobs` | 最近 20 条任务（刷新页面后仍能取回已打好的包） |
| POST | `/api/library/zipjob/cancel` | 取消任务（body `{id}`）：排队中直接作废，上传中断请求 |
| POST | `/api/upload` | 上传（multipart，支持相对路径带层级、空目录清单、署名标签） |
| POST | `/api/library/mkdir` | 新建文件夹 |
| POST | `/api/library/move` | 移动 / 重命名 |
| POST | `/api/library/paste` | 复制 / 剪切粘贴（两阶段：先校验成计划，全过才动盘） |
| POST | `/api/library/tag` | 贴署名（贴上后不可改） |

**路由归属**：Caddy 里 `/api/library/*` 和 `/api/upload*` 走 library，其余 `/api/*` 和 `/auth/*` 走 app。库的接口**没有删除类端点**。

### 数据表（SQLite，`app_data` 卷里的 `workroom.sqlite`）

| 表 | 存什么 |
|---|---|
| `sessions` | 登录会话（token 存哈希） |
| `oauth_states` | OAuth 中间态（防重放） |
| `records` | 工作记录（JSON payload + 版本号） |
| `directory_entries` | 公司入口登记 |
| `sync_jobs` / `sync_rows` / `sync_config` | 智能表格同步队列与映射 |

> **这个库是唯一的数据真源，且不在备份范围内。** 建议单独做定时备份。

---

## 八、前端模块（加载顺序即依赖顺序）

`index.html` 只有骨架，`bootstrap.js` 拿到登录态后**按固定顺序串行加载 12 个脚本**。每个模块自己往页面里插东西、往导航里插入口。**加载顺序就是依赖顺序，改一个可能影响后面几个。**

| 顺序 | 模块 | 职责 |
|---|---|---|
| 1 | `deletion.js` | 记录删除（要在编辑器首次渲染前挂上事件） |
| 2 | `app.js` | 今日记录编辑器 + 我的历史（核心工具函数 `$` / `esc` / `records` 由它提供） |
| 3 | `portal.js` | 建首页 / 资料 / 应用 / 组织 / 入口管理等 section 的容器，**统一重建左侧导航**（工作记录 / 库 / 设置 三段） |
| 4 | `team.js` | 团队记录页 |
| 5 | `mobile-ui.js` | 移动端底部导航与「更多」菜单 |
| 6 | `hub.js` | 把 portal 的本地入口升级为公司共享登记；重写首页为个人驾驶舱（含「工作数据」模块） |
| 7 | `journal-ui.js` | 首页视觉（品牌海报） |
| 8–11 | `vendor/marked.js`、`purify.js`、`highlight.js`、`hljs-langs.js` | Markdown 渲染（全部本地，不连 CDN） |
| 12 | `library-ui.js` | 资料库页（三栏 + 登记分组 + 拖拽入库 + 预览 + 下载 + 搜索） |

**导航现在只有一处来源**：`portal.js` 里的 `nav.innerHTML`。`hub.js` / `library-ui.js` 不再往导航里追加栏目 —— 这是收敛后的结果，以后加栏目改那一个地方。

**仍然叠加的部分**：同一个 `#home` 被 `portal.js` 建容器、`hub.js` 重写内容、`journal-ui.js` 再改视觉；`#materials` / `#apps` / `#organization` / `#skills` 四个 section 的 DOM 还在（资料库复用它们的 `entryCard` 渲染函数），但已不是路由 —— 直接访问 `#materials` 会回落到首页。

---

## 九、约定

### 内容侧（`dreamcity_workspace` 仓）

三条硬规矩：

1. **所有 `.md` 必须有 frontmatter**（`title` / `author` / `project` / `type` / `tags` / `status` / `created` / `updated`），缺字段会被 `check_frontmatter.py` 拦下
2. **视频和大文件不进 Git**，只登记在 `media/manifest.yaml`
3. **「谁能改」看 `author` 字段**，不看平台权限

目录职责：`workflows/` 放可复用流程，`knowledge/` 放事实结论，`projects/` 放项目产出，`media/` 只放索引。

命名：知识类文档 `YYYY-MM-DD-标题.md`，项目目录用小写英文 + 短横线。

### 代码侧（本仓）

- 后端保持零依赖，不引入 npm 包
- 提交信息用 `feat:` / `fix:` / `chore:` / `docs:` 前缀，中文描述
- 提交前跑一遍语法检查：`node --check <file>`
- 改前端记得更新缓存指纹（第五节）

### 上线流程

改 → 语法检查 → 更新指纹 → 部署 → 实测 → 清理测试数据 → 提交 → 双推（GitHub + Gitee）。

---

## 十、已知债务

按优先级排，都是真实存在的坑，不是猜测。

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | **SQLite 不在备份范围** | 数据丢了不可恢复，且它是唯一真源 | 加一条定时任务把 `app_data` 卷导出到 COS 或另一台机 |
| 2 | **前端层层叠加** | 8 个模块各自 patch 页面，加载顺序即依赖，改 A 崩 B | 中期把导航与 section 注册收敛成一张声明式表 |
| 3 | **两个服务重复实现认证** | `server.mjs` 与 `library/server.mjs` 各写一遍 session 判定 + CSRF 校验 | 抽成一个共享模块 |
| 4 | **署名机制有两个口径** | 仓库 frontmatter 用花名册 `id`（key/vndr/hao/alex），库页用 `署名标签`（Jole7/VD/大咖浩/Alex） | 写清对应关系，或统一成一套 |
| 5 | **COS 存放不保留目录层级** | 上传文件夹时，视频与大文件被扁平存到 `videos/年/月/`，层级只记在 manifest 里 | 需要保层级就要改对象 key 结构 |
| 6 | **`manifest.yaml` 的头部说明与实际写入格式不符** | 文件开头声明的是 YAML 结构（`items:` 列表 + `id/title/file/provider/locator` 等字段），但实际写入方（库服务与 `scripts/upload.py`）都是**追加扁平条目**（`- path:` / `- name:`）。文件里还留着 `items: []`，两者叠在一起**已经不是合法 YAML** | 二选一：① 承认实际格式，重写头部说明并删掉 `items: []`；② 让写入方改成读写 `items:` 列表 |
| 7 | **`_来源与部署说明.md` 是拉取记录** | 它写的是"这份代码怎么拉下来的"，不是项目文档，接手的人容易先读错 | 本 README 补上门面作用，那份专注运维细节 |
| 8 | **「工作台名称」只存在浏览器里** | 侧栏标题按浏览器各填各的，改一次只有自己看得见 | 挪进公司目录（同租户共享），或干脆改成固定文案 |
| 9 | **旧页面还挂在 DOM 里** | `#materials` / `#apps` / `#organization` 三个 section 已不在导航里，`route()` 也不认这三个 hash，但 `portal.js` 仍在渲染它们 | 确认库页的分组渲染不再依赖它们的 DOM 后删掉 |

> 2026-10-29 已清掉两条：仓库根的 4 个历史备份文件已移出 Git（历史仍在记录里）；入口配置的两套已收口——公司目录是唯一真源，旧浏览器的个人入口只作迁移来源，登记进公司后从本机移除。

---

## 十一、接手前先读这三份

| 文档 | 讲什么 |
|---|---|
| **本文件** | 项目全貌、架构、约定 |
| `_来源与部署说明.md` | 部署细节、接口细节、踩过的坑（**改库服务必读第七节**） |
| `dreamcity_workspace/README.md` | 内容侧的三层结构与协作规矩 |

---

*最后更新：2026-10-16*
