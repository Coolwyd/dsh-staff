# 发布到 DSH 插件市场 — 操作清单（按官方 contributing.md 校准）

> 校准时间：2026-10-24。依据：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md>
> 旧版本文里的「提交 JSON 到 PR、category 写 agent」已作废——官方现在只收 YAML 条目文件，且没有 `agent` 这个分类。

## 一、市场到底怎么收录（已核实）

| 环节 | 事实 |
|---|---|
| 入口 | DSH 设置 → 插件市场 →「申请收录插件 ↗」，指向 awesome-dsh-plugin 的 contributing.md |
| 投稿方式 | **不是上传包**。在 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR，**只加一个文件**：`data/plugins/<owner>__<repo>.yml` |
| README | 两个 README 由脚本从 `data/plugins/*.yml` 生成，**不要手工改** |
| 市场索引 | `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（npm 包 `dsh-plugin-catalog`）；npm 上有版本才会带版本号，纯 GitHub 条目只能给安装命令 |
| 评审 | 人工按图省事？不是——每人都会拿描述去核对源码（写「46 tools」就数 46 个） |

## 二、硬性条件 vs dsh-staff 现状

| 条件 | 现状 | 证据 |
|---|---|---|
| `package.json` 声明 `dsh.bundle` | ✅ 有 | `bundle.patch = ./cordis.patch.yml` |
| 仓库根有 `cordis.patch.yml` | ✅ 有 | insert id/name = dsh-staff |
| 真实可运行代码 | ✅ 有 | `index.js` 注册 19 个工具 + `client.js` 前端 |
| `npm pack --dry-run` 可打包 | ✅ 通过 | 9 文件 / 110.8 kB |
| 仓库描述属实 | ⚠️ 已修 | 原写「17 个工具」「群 2–6 人」，实际 19 个工具、2–8 人 |
| 公开 GitHub 仓库 | ❌ 缺 | `git remote -v` 为空 |
| `dsh-plugin` topic | ❌ 缺 | 仓库未建 |
| 仓库创建满 1 天 | ⏳ 待满足 | CI 自动检查，建仓当天提 PR 会被拒 |
| npm 已发布 | ❌ 缺 | 本机 `npm whoami` 未登录，包未发布 |
| `repository/homepage/bugs` | ⚠️ 占位符 | 仍是 `OWNER` |
| 图标（可选） | ⏳ | 市场卡片只收 **GitHub 托管位图**（png/jpg），`icon.svg` 不能用；不填则回退作者头像 |

## 三、执行步骤

### 0. 填仓库地址（把 `OWNER` 换成 GitHub 用户名）

```bash
cd /e/DSH/plugins/dsh-staff
sed -i 's/OWNER/<GitHub用户名>/g' package.json
grep -n 'github.com' package.json
```

### 1. 建公开仓库并推送

GitHub 新建 **Public** 仓库 `dsh-staff`，**不要**勾 README/.gitignore/LICENSE（本地已有），然后：

```bash
cd /e/DSH/plugins/dsh-staff
git add -A && git commit -m "chore: 2.1.0 发布准备"
git remote add origin https://github.com/<用户名>/dsh-staff.git
git branch -M main
git push -u origin main
```

### 2. 加 topic（决定能否被 GitHub 检索到）

仓库页 → About 齿轮 → Topics：`dsh-plugin`（必填），建议再加 `deepseek` `dsh` `agent-teams` `staff`。

### 3. 发布 npm（索引要版本号）

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org      # 打印用户名才算成功
cd /e/DSH/plugins/dsh-staff
npm publish --registry=https://registry.npmjs.org --access public
npm view dsh-staff version --registry=https://registry.npmjs.org   # 应为 2.1.0
```

> 本机默认源是淘宝镜像（`registry.npmmirror.com`），发布必须显式指定官方源，否则会失败或发到镜像。

### 4. Fork + 加条目文件

Fork 后新建 `data/plugins/<用户名>__dsh-staff.yml`（内容见 `docs/market-entry.yml` 示例，或根目录同名的暂存文件）。

### 5. 提 PR

标题：`Add dsh-staff`（或 `Add <用户名>/dsh-staff`）
正文写清：装的是什么、怎么装、跑过哪些验证。仓库建仓满 1 天后再提。

### 6. 合并后验证

```bash
# 索引里能搜到即成功（合并后几分钟）
npm view dsh-plugin-catalog --registry=https://registry.npmjs.org
```

## 四、风险

| 项 | 说明 |
|---|---|
| npm 包名不可回收 | 24 小时内可 `npm unpublish`，之后只能发新版本 |
| 版本号只能递增 | 2.1.0 之后必须 ≥ 2.1.1 |
| 仓库年龄门槛 | 建仓当天提 PR 必被 CI 拒，隔天再提即可，重新提交不留污点 |
| 描述必须属实 | 写「19 个工具」就要真能数出 19 个；夸大是被打回的头号原因 |
| 分类 | 只能从 `agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun` 里选，**没有 agent** |
| 能力声明 | 插件会写 `~/.dsh/staff/*.json`、开本机只读 HTTP 路由，README 需说明；卸载不删数据 |
