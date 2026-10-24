// 员工制插件 Host 侧：持久员工名册 + 工作账本。
// 设计边界：只做「员工档案与待办」的持久化，不创建会话、不改变 Agent Teams 的团队拓扑。
import { promises as fs, copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

// 工具注册依赖：缺失时不激活，避免静默失败
export const inject = ['tools']

//1. 解析名册落盘位置：优先 DSH_HOME，回退 ~/.dsh，保证跨工作区共享同一份编制
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'staff')
const ROSTER_PATH = path.join(DATA_DIR, 'roster.json')

//2. 统一日志前缀：所有工具入口、状态流转、落盘失败都带 [dsh-staff]，便于在 Host 日志定位
function log(level, message, detail) {
  const line = `[dsh-staff] ${message}`
  const payload = detail === undefined ? '' : detail
  if (level === 'error') console.error(line, payload)
  else if (level === 'warn') console.warn(line, payload)
  else console.log(line, payload)
}

//2.1 进程内写串行化：名册与群文件都是「读—改—写」，并发调用会互相覆盖
//     用一个 Promise 链把所有写操作排队，保证同一进程内的写入不交错
let writeQueue = Promise.resolve()

//2.2 把一次完整写操作整体排队；失败不阻断后续任务，避免一次异常卡死队列
function serialize(task) {
  const next = writeQueue.then(task, task)
  writeQueue = next.then(() => undefined, () => undefined)
  return next
}

//2.3 客户端心跳：组件挂载后上报一次，用于在无法打开浏览器时确认前端真的加载了
let clientPingAt = null
let clientPingSource = null

//2.4 自动驾驶状态：默认关闭，内存态，重启即停，避免无人值守时自动烧钱
const autopilot = { enabled: false, dailyLimit: 20, used: 0, day: '' }

//2.5 存储层改造（P0-1/P0-3）：原 readRoster/readGroups/readDms 把「JSON 损坏」当成空集合，
//     任何一次后续写回都会用空数据整体覆盖存量；且只有进程内 Promise 队列，两个 Host 同时写会互相覆盖。
//     改为单例 store：损坏先留证（.corrupt-<时间戳>）再回落 .bak；写 = 跨进程锁 + 锁内读改写 + 原子写。
const STORES = {}

//2.6 跨进程文件锁：open(lock,'wx') 是原子创建，建成功者持锁；锁文件内容写「pid@时间戳」便于排障。
//    mtime 超过 15s 视为陈旧（持锁进程已崩）可抢占；总等待上限 3000ms，超时抛 STAFF_LOCK_TIMEOUT，绝不无限等。
const LOCK_STALE_MS = 15000
const LOCK_WAIT_MS = 3000
const LOCK_RETRY_MS = 40
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
//2.6.1 可恢复的抢锁失败只有三类：锁被持有（等）、锁陈旧（抢占后重试）、Windows 删除挂起（等）。
//      其余错误直接上抛，避免把权限/磁盘问题伪装成「忙」。
async function acquireFileLock(file) {
  const lockPath = file + '.lock'
  const deadline = Date.now() + LOCK_WAIT_MS
  //2.6.2 持有者令牌带随机后缀：释放时先核对内容，避免抢到锁后被前人误删（锁文件是共享路径）
  const token = process.pid + '@' + Date.now() + '@' + Math.random().toString(36).slice(2, 8)
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      //2.6.3 令牌写失败不影响持锁，仅丢失排障信息
      try { await handle.writeFile(token, 'utf8') } catch (error) { /* 忽略 */ }
      return async () => {
        try { await handle.close() } catch (error) { /* 已关闭 */ }
        try {
          const current = await fs.readFile(lockPath, 'utf8')
          //2.6.4 只有锁内容仍是自己时才删除：被别人抢占后直接删会把后来者的锁打掉
          if (current === token) await fs.rm(lockPath, { force: true })
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            log('warn', '释放文件锁失败', { lockPath, reason: error instanceof Error ? error.message : String(error) })
          }
        }
      }
    } catch (error) {
      const code = error && error.code
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      //2.6.5 陈旧锁判定：只有 stat 成功且 mtime 超过 15s 才允许抢占（进程被强杀才会留下这种锁）。
      //      stat 失败说明锁刚被释放或处于 Windows 删除挂起状态，此时绝不能 rm 别人正在持有的锁文件：
      //      Windows 删除被占用的文件会进入 delete-pending，紧接着 open('wx') 直接 EPERM，反而把等待方打挂。
      let stale = false
      try {
        const stat = await fs.stat(lockPath)
        stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS
      } catch (statError) {
        stale = false
      }
      if (stale) {
        log('warn', '抢占陈旧文件锁', { lockPath })
        try { await fs.rm(lockPath, { force: true }) } catch (rmError) { /* 别人已释放或已抢到 */ }
        continue
      }
      if (Date.now() >= deadline) {
        const timeout = new Error('等待写入锁超时（' + LOCK_WAIT_MS + 'ms）：' + lockPath)
        timeout.code = 'STAFF_LOCK_TIMEOUT'
        throw timeout
      }
      await waitMs(LOCK_RETRY_MS)
    }
  }
}

//2.7 原子写：tmp(wx)→fsync→copyFile 目标到 .bak→rename 覆盖。.bak 保存「上一次成功写入的版本」，
//    是 A-01 损坏恢复的唯一依据；Windows 上 rename 被杀毒/索引占用会 EPERM/EBUSY/EACCES，退避重试 3 次。
const RENAME_RETRY = 3
const RENAME_RETRY_MS = 50
const TMP_MAX_AGE_MS = 3600000
//2.7.1 清理本文件超过 1h 的残留 tmp：进程中断会留下 tmp，长期累积会撑大目录
async function cleanupStaleTmp(dir, baseName) {
  try {
    const names = await fs.readdir(dir)
    const now = Date.now()
    for (const name of names) {
      if (!name.startsWith(baseName + '.') || !name.endsWith('.tmp')) continue
      const target = path.join(dir, name)
      try {
        const stat = await fs.stat(target)
        if (now - stat.mtimeMs > TMP_MAX_AGE_MS) await fs.rm(target, { force: true })
      } catch (error) { /* 单个文件失败不影响落盘 */ }
    }
  } catch (error) { /* 目录不可读时放弃清理，不影响写入主流程 */ }
}
async function atomicWriteFile(file, value, options) {
  //2.7.0 keepBak：从 .bak 恢复出来的数据写回时不能再用「当前坏文件」覆盖好备份，否则备份也一起坏掉
  const keepBak = Boolean(options && options.keepBak)
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  //2.7.2 唯一 tmp 名 + wx：同目录并发写不会互相截断
  const tmp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
  const body = JSON.stringify(value, null, 2)
  const handle = await fs.open(tmp, 'wx')
  try {
    await handle.writeFile(body, 'utf8')
    //2.7.3 先 fsync 内容再改名：断电时不会留下「名字已改但内容为空」的文件
    await handle.sync()
  } finally {
    await handle.close()
  }
  //2.7.4 备份上一版：首次写入没有目标文件（ENOENT）是正常情况，不算失败
  if (!keepBak) {
    try {
      await fs.copyFile(file, file + '.bak')
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        log('warn', '备份上一版失败', { file, reason: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  let renamed = false
  let lastError = null
  for (let attempt = 1; attempt <= RENAME_RETRY; attempt += 1) {
    try {
      await fs.rename(tmp, file)
      renamed = true
      break
    } catch (error) {
      lastError = error
      const code = error && error.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      await waitMs(RENAME_RETRY_MS)
    }
  }
  if (!renamed) {
    try { await fs.rm(tmp, { force: true }) } catch (error) { /* 残留由定时清理兜底 */ }
    throw lastError || new Error('重命名落盘失败：' + file)
  }
  //2.7.5 尽力 fsync 目录：Windows 打开目录会 EPERM/EISDIR，失败忽略；Linux 上才真正生效
  try {
    const dirHandle = await fs.open(dir, 'r')
    try { await dirHandle.sync() } finally { await dirHandle.close() }
  } catch (error) { /* 平台不支持，忽略 */ }
  await cleanupStaleTmp(dir, path.basename(file))
}

//2.8 存储单例：四个文件共用「校验 / 损坏留证 / 回落备份 / 跨进程锁 / 原子写」一套状态机
function createStore({ name, file, empty, validate }) {
  const store = {
    name,
    file,
    //2.8.1 健康度是 read 的副产物：ok/missing/corrupt/restored，供 doctor 与 snapshot 汇总
    state: { health: 'unknown', reason: null, at: null, corruptSignature: null },
    //2.8.2 进程内 per-store 队列：同一文件的写在一个进程里严格串行，避免自己和自己抢文件锁
    queue: Promise.resolve(),
    read() {
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          store.mark('missing', null)
          return empty()
        }
        log('error', '存储读取失败', { store: name, file, reason: error instanceof Error ? error.message : String(error) })
        store.mark('corrupt', error instanceof Error ? error.message : String(error))
        return empty()
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return store.handleCorrupt('JSON 解析失败：' + (error instanceof Error ? error.message : String(error)))
      }
      if (!validate(parsed)) return store.handleCorrupt('结构不合法')
      store.mark('ok', null)
      return parsed
    },
    mark(health, reason) {
      store.state = { health, reason, at: new Date().toISOString(), corruptSignature: store.state.corruptSignature }
    },
    //2.8.3 损坏处理：先把坏文件整体复制为 .corrupt-<ISO时间戳> 保留证据（同一份坏内容只留一次），
    //      再尝试 .bak；备份有效则 health=restored 继续用备份数据，无备份则 health=corrupt（写操作会拒绝）。
    handleCorrupt(reason) {
      let signature = null
      try {
        const stat = statSync(file)
        signature = stat.size + ':' + Math.floor(stat.mtimeMs)
      } catch (error) { /* stat 失败极少见，按无签名处理 */ }
      if (signature && store.state.corruptSignature !== signature) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const corruptPath = file + '.corrupt-' + stamp
        try {
          copyFileSync(file, corruptPath)
          store.state.corruptSignature = signature
          log('error', '检测到存储损坏，已保留坏文件副本', { store: name, file, corruptPath, reason })
        } catch (error) {
          log('error', '保留坏文件副本失败', { store: name, file, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      const bakPath = file + '.bak'
      try {
        const bakParsed = JSON.parse(readFileSync(bakPath, 'utf8'))
        if (validate(bakParsed)) {
          store.mark('restored', reason)
          log('warn', '存储损坏，已从备份恢复', { store: name, file, bakPath, reason })
          return bakParsed
        }
        log('error', '备份文件结构也不合法，按损坏处理', { store: name, bakPath, reason })
      } catch (error) {
        log('error', '没有可用的备份文件，按损坏处理', { store: name, bakPath, reason })
      }
      store.mark('corrupt', reason)
      return empty()
    },
    //2.8.4 写：进程内队列 + 跨进程锁；锁内「读→改→原子写」。损坏且无备份时显式抛 STAFF_STORE_CORRUPT，
    //      绝不用空数据覆盖存量（P0-1 的核心要求）。
    mutate(operation) {
      return store.enqueue(async () => {
        const release = await acquireFileLock(file)
        try {
          const data = store.read()
          if (store.state.health === 'corrupt') {
            const error = new Error('存储文件损坏且无可用备份，拒绝写入以免覆盖存量：' + file)
            error.code = 'STAFF_STORE_CORRUPT'
            log('error', '拒绝写入损坏存储', { store: name, file, reason: store.state.reason })
            throw error
          }
          const result = await operation(data)
          //2.8.4.1 恢复态写回时保留原 .bak（那才是有效备份），等下一次正常写入再滚动备份
          await atomicWriteFile(file, data, { keepBak: store.state.health === 'restored' })
          store.mark('ok', null)
          return result
        } finally {
          await release()
        }
      })
    },
    //2.8.5 整份替换：给仍按「读整份→改整份→写整份」调用的既有工具保留原签名（零调用点改动），
    //      同样加锁并原子落盘；但并发读写之间仍可能丢更新，属后续按 store.mutate 收敛的遗留项。
    replace(value) {
      return store.enqueue(async () => {
        const release = await acquireFileLock(file)
        try {
          store.read()
          if (store.state.health === 'corrupt') {
            const error = new Error('存储文件损坏且无可用备份，拒绝写入以免覆盖存量：' + file)
            error.code = 'STAFF_STORE_CORRUPT'
            log('error', '拒绝写入损坏存储', { store: name, file, reason: store.state.reason })
            throw error
          }
          await atomicWriteFile(file, value, { keepBak: store.state.health === 'restored' })
          store.mark('ok', null)
        } finally {
          await release()
        }
      })
    },
    enqueue(task) {
      const next = store.queue.then(task, task)
      store.queue = next.then(() => undefined, () => undefined)
      return next
    },
    health() {
      return { health: store.state.health, reason: store.state.reason, at: store.state.at }
    },
  }
  STORES[name] = store
  return store
}

//2.9 四个存储文件的路径与单例：路径集中在这里定义，后面的读函数只做结构归一化
const GROUP_PATH = path.join(DATA_DIR, 'groups.json')
const DMS_PATH = path.join(DATA_DIR, 'dms.json')
const BROKEN_PATH = path.join(DATA_DIR, 'broken-members.json')
//2.9.1 每群消息上限：A-11 群消息无上限会让 groups.json 无限膨胀、读盘与快照越来越慢
const GROUP_MESSAGE_LIMIT = 500
const rosterStore = createStore({
  name: 'roster',
  file: ROSTER_PATH,
  empty: () => ({ version: 1, employees: {} }),
  validate: (parsed) => Boolean(parsed) && typeof parsed === 'object' && Boolean(parsed.employees) && typeof parsed.employees === 'object',
})
const groupsStore = createStore({
  name: 'groups',
  file: GROUP_PATH,
  empty: () => ({ version: 1, groups: {} }),
  validate: (parsed) => Boolean(parsed) && typeof parsed === 'object' && Boolean(parsed.groups) && typeof parsed.groups === 'object',
})
const dmsStore = createStore({
  name: 'dms',
  file: DMS_PATH,
  empty: () => ({ version: 1, conversations: {} }),
  validate: (parsed) => Boolean(parsed) && typeof parsed === 'object' && Boolean(parsed.conversations) && typeof parsed.conversations === 'object',
})
const brokenStore = createStore({
  name: 'broken',
  file: BROKEN_PATH,
  empty: () => ({ members: {} }),
  validate: (parsed) => Boolean(parsed) && typeof parsed === 'object' && Boolean(parsed.members) && typeof parsed.members === 'object',
})
//2.9.2 健康度汇总：doctor/snapshot 只读这里，不重复读盘
function storeHealth() {
  return { roster: rosterStore.health(), groups: groupsStore.health(), dms: dmsStore.health(), broken: brokenStore.health() }
}
//2.9.5 定位某存储最近一次损坏副本：doctor 要把证据路径直接给到人，而不是只说「损坏了」
function latestCorruptCopy(file) {
  try {
    const base = path.basename(file) + '.corrupt-'
    const dir = path.dirname(file)
    const hits = readdirSync(dir).filter((item) => item.startsWith(base)).sort()
    return hits.length > 0 ? path.join(dir, hits[hits.length - 1]) : null
  } catch (error) {
    return null
  }
}
//2.9.3 跨库事务：按 store 名排序取锁避免死锁，全部读成功才改，全部写成功才返回（fire 等跨库场景备用）
async function mutateMany(names, operation) {
  const ordered = names.map((item) => STORES[item]).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))
  const releases = []
  try {
    for (const store of ordered) releases.push(await acquireFileLock(store.file))
    const dataMap = {}
    for (const store of ordered) {
      dataMap[store.name] = store.read()
      if (store.state.health === 'corrupt') {
        const error = new Error('存储文件损坏且无可用备份，拒绝写入以免覆盖存量：' + store.file)
        error.code = 'STAFF_STORE_CORRUPT'
        throw error
      }
    }
    //2.9.4 恢复态的库写回时保留原 .bak，避免好备份被当前坏文件覆盖
    const keepBakMap = {}
    for (const store of ordered) keepBakMap[store.name] = store.state.health === 'restored'
    const result = await operation(dataMap)
    for (const store of ordered) {
      await atomicWriteFile(store.file, dataMap[store.name], { keepBak: keepBakMap[store.name] })
      store.mark('ok', null)
    }
    return result
  } finally {
    for (const release of releases.reverse()) {
      try { await release() } catch (error) { /* 释放失败只影响排障，不影响结果 */ }
    }
  }
}

//3. 读取名册：缺失按空名册；损坏时先留证再回落 .bak，无备份则 health=corrupt（写操作会显式失败）
async function readRoster() {
  const parsed = rosterStore.read()
  return { version: parsed.version ?? 1, employees: parsed.employees ?? {} }
}

//4. 原子写名册：整份替换（跨进程锁 + tmp/fsync/.bak/rename）；损坏且无备份时抛错，不再用空名册覆盖
async function writeRoster(roster) {
  await rosterStore.replace(roster)
}

//4.1.1 工作日的边界：每天 6 点为界，6 点前算前一天，用于「按天分组」与跨天判断
const DAY_START_HOUR = 6
function dayKeyOf(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  if (date.getHours() < DAY_START_HOUR) date.setDate(date.getDate() - 1)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
function currentDayKey() {
  return dayKeyOf(new Date())
}

//4.1.3a 路径归一化：统一分隔符与大小写，规避 Windows 反斜杠与用户输入正斜杠不一致
function normalizeWorkspacePath(input) {
  return String(input || '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

//4.1.3 工作区索引：把磁盘路径映射到 workspaceId，供界面在指定工作区新开会话
const WORKSPACE_INDEX_PATH = path.join(DSH_HOME, 'storages', 'workspace.json')
async function readWorkspaceIndex() {
  try {
    const text = await fs.readFile(WORKSPACE_INDEX_PATH, 'utf8')
    const parsed = JSON.parse(text)
    const table = parsed && parsed.tables && parsed.tables.workspaces
    if (!table || typeof table !== 'object') {
      log('warn', '工作区索引结构不合法', WORKSPACE_INDEX_PATH)
      return {}
    }
    //4.1.4 以小写路径为键，规避 Windows 盘符与大小写差异
    const map = {}
    for (const [workspaceId, view] of Object.entries(table)) {
      const workspacePath = view && typeof view.path === 'string' ? view.path : ''
      //4.1.4 归一化后作键，保证 E:/DSH 与 E:\DSH 命中同一项
      const normalized = normalizeWorkspacePath(workspacePath)
      if (normalized) map[normalized] = workspaceId
    }
    return map
  } catch (error) {
    log('warn', '工作区索引读取失败', {
      path: WORKSPACE_INDEX_PATH,
      reason: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

//4.1.9 员工工位使用的 provider：
//4.1.10 'spawn' 是 Agent Teams 认可的 subagent provider 标识，DSH 会解析成当前可用的那个；
//4.1.11 实测填真实 provider 名会被拒绝：no subagent provider registered for "xxx"；填 ddd 则 no adapter。故只能用 'spawn'
const TEAMMATE_PROVIDER = process.env.DSH_STAFF_PROVIDER || 'spawn'

//4.1.12 坏工位名单：投递时发现某成员实际不可用就记下来，下次直接跳过，避免反复唤醒坏 agent
async function readBroken() {
  const parsed = brokenStore.read()
  return { members: parsed.members ?? {} }
}
async function markBroken(memberName, reason) {
  try {
    //4.1.13 走 store.mutate：加锁 + 原子写，多个投递并发写不会互相覆盖；文件损坏时拒绝覆盖并告警
    await brokenStore.mutate((store) => {
      if (!store.members || typeof store.members !== 'object') store.members = {}
      store.members[memberName] = { reason: String(reason || '').slice(0, 200), at: new Date().toISOString() }
    })
    log('warn', '标记坏工位', { memberName, reason })
  } catch (error) {
    log('warn', '写坏工位名单失败', { memberName, reason: error instanceof Error ? error.message : String(error) })
  }
}

//4.1.30 工位缺失判定：teammate 是会话内实体，历史会话结束后成员名就查不到了，
//       这不是「彻底坏掉」，重建一次即可恢复，不能永久拉黑成不可用工位
function isMissingMemberReason(reason) {
  const text = String(reason || '')
  return /not found|no such|不存在|未找到/i.test(text)
}

//4.1.31 自愈成功后清除坏工位记录：留着会让下一次投递继续被短路
async function clearBroken(memberName) {
  try {
    await brokenStore.mutate((store) => {
      if (!store.members || typeof store.members !== 'object') return
      if (store.members[memberName]) delete store.members[memberName]
    })
    log('info', '已清除坏工位记录', { memberName })
  } catch (error) {
    log('warn', '清除坏工位记录失败', { memberName, reason: error instanceof Error ? error.message : String(error) })
  }
}

//4.1.14 员工专属会话：每个员工在 yuangong 工作区各占一个会话，彻底绕开单会话 7 人上限
const STAFF_WORKSPACE = process.env.DSH_STAFF_WORKSPACE || 'E:/yuangong'
//4.1.20 专属会话开关：默认关闭。开启后每个员工会在 yuangong 工作区独占一个会话，
//4.1.21 但 agents.create 造的会话在插件重载后会在内存注册表留下「已存在但无 agent」的残影，
//4.1.22 且新建会话立刻 spawn 会报 initial prompt was not durably accepted，当前不稳定，故默认走原路径
//4.1.27 专属会话默认关闭：agents.create 造的会话无法稳定承载 teammate（initial prompt was not durably accepted）
const STAFF_SESSION_ENABLED = process.env.DSH_STAFF_SESSIONS === '1'
//4.1.24 员工工位根目录：每个员工在 yuangong 下拥有独立目录与知识库
const STAFF_HOME = process.env.DSH_STAFF_HOME || 'E:/yuangong'
//4.1.24.0 员工名会直接拼进文件系统路径（工位目录、知识库目录），必须先过白名单：
//        否则 name='../../../x' 这类名字能把知识库写到工作区之外（实测已复现过越界写盘）
const MEMBER_NAME_MAX = 40
function isValidMemberName(name) {
  const text = name === null || name === undefined ? '' : String(name)
  if (text.trim() === '' || text.length > MEMBER_NAME_MAX) return false
  if (text !== text.trim()) return false
  // 路径分隔符、Windows 保留字符、控制字符、通配符一律不允许
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(text)) return false
  // . 与 .. 以及任何含 .. 的名字（含编码绕过前的形态）直接拒绝
  if (text === '.' || text.indexOf('..') >= 0) return false
  //4.1.24.2 尾部点：Win32 传统 API 会 trim，Node 不会，两边解析出不同目录（qa P2-2，纯防御）
  if (/[.]$/.test(text)) return false
  //4.1.24.3 Windows 保留设备名：Node 走 verbatim 路径能建目录，但外部备份/同步/解压工具会按设备解析（qa P2-1）
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])([.].*)?$/i.test(text)) return false
  //4.1.24.4 原型链关键字：名册是普通对象，employees["__proto__"]=record 会改原型而不是加键，
  //        结果 hire 报「已更新档案」但名册里没有这个人，JSON 序列化出来是 {}（qa 复验实测 P2-5）
  if (/^(__proto__|constructor|prototype)$/.test(text)) return false
  return true
}
function assertMemberName(name) {
  if (!isValidMemberName(name)) {
    throw new Error('员工名「' + String(name) + '」不合法：名字会用作目录名，不能包含 / \\ : * ? " < > | 、不能含 ..、长度不超过 ' + MEMBER_NAME_MAX + ' 字')
  }
}
function staffWorkspacePath(name) {
  assertMemberName(name)
  const root = path.resolve(STAFF_HOME)
  const resolved = path.resolve(root, String(name))
  //4.1.24.1 双保险：解析后必须仍在工位根目录之下，兜住任何未预料的拼接写法
  if (resolved !== root && resolved.indexOf(root + path.sep) !== 0) {
    throw new Error('员工名「' + String(name) + '」解析后越出工位根目录，已拒绝')
  }
  return resolved
}
function staffKbPath(name) {
  return path.join(staffWorkspacePath(name), '知识库')
}

//4.1.25 写入员工知识库：按天归档，单日超阈值自动切主题文件，避免无限增长
const KB_DAY_LIMIT = 200
const KB_CHAR_LIMIT = 12000
//4.1.29 同一自然日最多保留 5 个分片文件，超过就追加到最后一个，防止归档碎片化
const KB_PIECE_LIMIT = 5
async function archiveToKb(name, text, tag) {
  const NL = String.fromCharCode(10)
  const body = String(text || "").trim()
  if (body === "") return { ok: false, reason: "内容为空" }
  //4.1.25.1 路径非法时返回可读原因而不是把异常抛到工具层（宿主侧会当系统错误回 500）
  let kbDir = ''
  try {
    kbDir = staffKbPath(name)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  try {
    await fs.mkdir(kbDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: "知识库目录不可建：" + (error instanceof Error ? error.message : String(error)) }
  }
  const day = currentDayKey()
  const dayFile = path.join(kbDir, day + ".md")
  let existing = ""
  try { existing = await fs.readFile(dayFile, "utf8") } catch (error) { existing = "" }
  //4.1.26 单日超行数或字数阈值即切到主题文件，文件名带时间戳避免同主题互相覆盖
  const lineCount = existing === "" ? 0 : existing.split(NL).length
  let target = dayFile
  if (lineCount >= KB_DAY_LIMIT || existing.length >= KB_CHAR_LIMIT) {
    //4.1.28 D-02 修复：同日分片数量设上限，超上限追加到最后一个分片，避免归档越写越碎
    const safeTag = String(tag || "more").replace(/[^0-9A-Za-z一-龥_-]/g, "_").slice(0, 20)
    let pieces = []
    try {
      const names = await fs.readdir(kbDir)
      pieces = names.filter((n) => n.startsWith(day + "-") && n.endsWith(".md")).sort()
    } catch (error) { pieces = [] }
    if (pieces.length >= KB_PIECE_LIMIT) {
      target = path.join(kbDir, pieces[pieces.length - 1])
      try { existing = await fs.readFile(target, "utf8") } catch (error) { existing = "" }
    } else {
      target = path.join(kbDir, day + "-" + safeTag + "-" + Date.now().toString(36) + ".md")
      existing = ""
    }
  }
  const stamp = new Date().toISOString()
  const block = NL + "## " + (tag || "记录") + " · " + stamp + NL + NL + body + NL
  const head = existing === "" ? "# " + name + " 知识库 · " + day + NL + block : block
  try {
    await fs.appendFile(target, head, "utf8")
    return { ok: true, file: target, archived: body.length }
  } catch (error) {
    return { ok: false, reason: "写入失败：" + (error instanceof Error ? error.message : String(error)) }
  }
}

//4.1.18 前缀带版本：旧前缀在内存注册表里留有「已存在但无 agent」的残影，换前缀才能重建
const STAFF_SESSION_PREFIX = 'emp-'
//4.1.16 最近一次专属会话创建的失败原因，供诊断动作读取（Host 日志看不到时用它）
let lastStaffSessionError = null
async function ensureStaffSession(agents, memberName) {
  if (!STAFF_SESSION_ENABLED) return null
  if (!agents || typeof agents.create !== 'function') return null
  const sessionId = STAFF_SESSION_PREFIX + memberName
  //4.1.15 已存在就直接复用，避免每次投递都造会话
  if (typeof agents.get === 'function') {
    try {
      const existing = agents.get(sessionId)
      if (existing) return existing
    } catch (error) { /* 不存在则继续创建 */ }
  }
  //4.1.23 建会话 + 等待写入器就绪，整体重试三次；每次换一个带时间戳的 sessionId 绕开内存残留
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const attemptId = attempt === 1 ? sessionId : sessionId + '-' + Date.now().toString(36)
    try {
      //4.1.17 agents.create 接受的是 sessionId，写成 id 会被忽略并自动编号（session-N），导致 id 与 session 不匹配
      const handle = await agents.create({
        sessionId: attemptId,
        meta: { cwd: STAFF_WORKSPACE },
      })
      const created = handle && handle.agent ? handle.agent : null
      if (!created) {
        lastStaffSessionError = { memberName, sessionId: attemptId, reason: 'create 未返回 agent' }
        continue
      }
      //4.1.19 新建会话的日志写入器需要时间就绪，立刻 spawn 会报 initial prompt was not durably accepted
      await new Promise((resolve) => setTimeout(resolve, 2500))
      log('info', '员工专属会话已创建', { memberName, sessionId: attemptId, attempt, workspace: STAFF_WORKSPACE })
      lastStaffSessionError = null
      return created
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      lastStaffSessionError = { memberName, sessionId: attemptId, attempt, reason }
      log('warn', '员工专属会话创建失败', { memberName, sessionId: attemptId, attempt, reason })
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
  }
  return null
}

//4.2 读取群数据：缺失按空集合；损坏先留证再回落 .bak，无备份则 health=corrupt（写操作会显式失败）
async function readGroups() {
  const parsed = groupsStore.read()
  return { version: parsed.version ?? 1, groups: parsed.groups ?? {} }
}

//4.3 原子写群数据：整份替换，与名册共用同一把跨进程锁与原子写实现
async function writeGroups(groups) {
  await groupsStore.replace(groups)
}

//4.5 读取私聊：缺失按空集合；损坏先留证再回落 .bak
async function readDms() {
  const parsed = dmsStore.read()
  return { version: parsed.version ?? 1, conversations: parsed.conversations ?? {} }
}

//4.6 原子写私聊：整份替换
async function writeDms(dms) {
  await dmsStore.replace(dms)
}

//5. 参数校验：所有工具入口共用，缺失或空白直接拒绝，避免写入无意义档案
function requireText(args, key, label) {
  const value = args && typeof args === 'object' ? args[key] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label || key} 不能为空`)
  }
  return value.trim()
}

//6. 生成任务号：时间戳 + 随机后缀，保证同一毫秒内多次派活也不冲突
function nextTaskId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

//7. 任务状态白名单：账本只接受四个状态，防止模型写入无法聚合的中间态
const TASK_STATUS = new Set(['todo', 'doing', 'done', 'blocked'])

//8. 单员工视图：工具返回值统一用它，保证列表与详情口径一致
function employeeView(name, record) {
  const todos = Array.isArray(record.todos) ? record.todos : []
  return {
    name,
    post: record.post ?? '',
    duty: record.duty ?? '',
    model: record.model ?? null,
    member: record.member ?? null,
    status: record.status ?? 'active',
    hiredAt: record.hiredAt ?? null,
    updatedAt: record.updatedAt ?? null,
    todoCount: todos.filter((item) => item.status === 'todo').length,
    doingCount: todos.filter((item) => item.status === 'doing').length,
    doneCount: todos.filter((item) => item.status === 'done').length,
    blockedCount: todos.filter((item) => item.status === 'blocked').length,
  }
}

//9. 名册表格渲染：工具输出与 UI 之外的纯文本回显共用，保证人类可读
function renderRoster(rows) {
  if (rows.length === 0) return '当前没有在册员工。用 staff_hire 招募第一名员工。'
  const header = '| 姓名 | 岗位 | 状态 | 待办 | 进行 | 完成 | 阻塞 |'
  const divider = '| --- | --- | --- | --- | --- | --- | --- |'
  const body = rows.map((row) =>
    `| ${row.name} | ${row.post} | ${row.status} | ${row.todoCount} | ${row.doingCount} | ${row.doneCount} | ${row.blockedCount} |`)
  return [header, divider, ...body].join('\n')
}

//10. 员工详情渲染：含职责与任务明细，供 staff_show 直接回显
function renderEmployee(view, record) {
  const lines = [
    `员工：${view.name}`,
    `岗位：${view.post}`,
    `职责：${view.duty}`,
    `状态：${view.status}`,
    `入职：${view.hiredAt ?? '未知'}`,
  ]
  const todos = Array.isArray(record.todos) ? record.todos : []
  if (todos.length === 0) {
    lines.push('待办：暂无')
  } else {
    lines.push('待办：')
    for (const item of todos) {
      lines.push(`- [${item.status}] ${item.id} ${item.text}`)
    }
  }
  return lines.join('\n')
}

//10.1 岗位模板：招募时可直接引用，避免每次重写岗位说明书；显式传入的 post/duty 优先于模板
const STAFF_TEMPLATES = {
  secretary: {
    post: '首席执行秘书',
    duty: '一、职责\n1. 情报调研：跟踪国内外 AI、科技、商业前沿动态，优先读英文一手信源，输出「结论 + 依据 + 影响判断」，禁止只丢链接列表。\n2. 日程与待办：维护老板的待办清单，主动提醒到期项，跟进未闭环事项。\n3. 材料起草：中英双语起草、润色、翻译文档、邮件、汇报提纲，交付前自检事实与口径。\n4. 会议支持：整理纪要，提炼决策点，列出待办、责任人与时限。\n5. 跨界接入：遇到不熟悉领域，先检索验证再回答，标注来源与不确定度。\n\n二、边界\n1. 不代替老板做决策，只给选项、依据、风险。\n2. 对外发送、花钱、删除文件、作出承诺，必须先请示。\n3. 不确定就说不确定，严禁编造数据、来源、引文。\n4. 不执行数据库写操作，不碰生产环境。\n\n三、风格\n先结论后依据；中文为主，专业术语保留英文原文；不堆砌形容词。',
  },
  researcher: {
    post: '研究助理',
    duty: '一、职责\n1. 资料检索：按指定主题收集一手资料，标注来源与时间。\n2. 事实核查：对已给结论逐条核对证据，指出无依据的部分。\n3. 结构化整理：把杂乱材料整理成「结论 + 依据 + 待确认」三段式。\n\n二、边界\n1. 只查证不决策，结论交老板或秘书判断。\n2. 不确定就说不确定，严禁编造来源与数据。\n3. 不执行数据库写操作，不碰生产环境。\n\n三、风格\n先给核查结论，再列证据；不堆砌形容词。',
  },
  engineer: {
    post: '工程师',
    duty: '一、职责\n1. 按需求实现代码，改动前先读现有实现与项目风格。\n2. 每次改动必须有运行验证或测试证据，未验证不交付。\n3. 交付时说明改动点、影响范围、回归风险。\n\n二、边界\n1. 不做需求外的重构，不擅自升级依赖。\n2. 涉及数据库只允许只读，禁止增删改。\n3. 不确定的技术判断先查证，不猜。\n\n三、风格\n最小改动优先；先结论后依据。',
  },
  tester: {
    post: '测试负责人',
    duty: '一、职责\n1. 为需求设计验收用例，覆盖正常流、边界、异常。\n2. 执行验证并给出可复现的证据（命令、输出、截图）。\n3. 缺陷报告写清复现路径、期望值与实际值。\n\n二、边界\n1. 不修改业务代码，只出结论与证据。\n2. 测试通过才可说通过，不写「应该没问题」。\n3. 不碰生产环境与数据库写操作。\n\n三、风格\n证据先行；结论明确到能否放行。',
  },
  product: {
    post: '产品经理',
    duty: '一、职责\n1. 需求澄清：把模糊诉求拆成可验收的用户故事。\n2. 优先级：按影响面与成本给出排序建议。\n3. 验收：定义每个需求的完成标准。\n\n二、边界\n1. 不做技术实现决策，交给工程判断。\n2. 不代替老板拍板，只给选项与权衡。\n3. 不编造用户数据。\n\n三、风格\n先给结论与取舍，再展开。',
  },
  ops: {
    post: '运维 / SRE',
    duty: '一、职责\n1. 部署与配置变更，变更前说明回滚方案。\n2. 监控与告警排查，先定位再动手。\n3. 事故复盘：时间线、根因、改进项。\n\n二、边界\n1. 生产变更必须先请示，禁止先斩后奏。\n2. 不执行数据库写操作。\n3. 不删除未确认路径的文件。\n\n三、风格\n风险前置；每一步说清可逆性。',
  },
}

//11. 招募工具：同名即更新岗位与职责，保留既有任务，避免升级档案时丢工作记录
const hireTool = {
  name: 'staff_hire',
  description: '招募或更新一名员工，写入持久名册。同名员工再次调用表示调整岗位/职责，既有任务记录保留。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '员工姓名，作为唯一标识，可使用中文' },
      template: { type: 'string', description: `可选：岗位模板，取值 ${Object.keys(STAFF_TEMPLATES).join(' / ')}；传了模板可省略 post 与 duty` },
      post: { type: 'string', description: '岗位名称，例如「后端工程师」「测试负责人」；使用 template 时可省略' },
      duty: { type: 'string', description: '职责边界：长期负责什么、什么情况下必须停下请示；使用 template 时可省略' },
      model: { type: 'string', description: '可选：该员工默认使用的模型 ID' },
      member: { type: 'string', description: '可选：绑定的 Agent Teams teammate 名（lower-kebab-case），用于群消息投递；不传则保留原绑定' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        post: { type: 'string' },
        created: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : `员工 ${args.name} 已入册` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '员工姓名')
    //11.0.0 入册即校验名字：名字将来要当目录名，不能让脏名字先存进名册再在归档时炸
    assertMemberName(name)
    //11.0 模板解析：显式 post/duty 优先于模板，两者都没有则拒绝，避免写入空岗位
    const templateKey = args && typeof args.template === 'string' && args.template.trim() !== '' ? args.template.trim() : ''
    const template = templateKey ? STAFF_TEMPLATES[templateKey] : null
    if (templateKey && !template) throw new Error(`未知模板「${templateKey}」，可用：${Object.keys(STAFF_TEMPLATES).join('、')}`)
    const post = (args && typeof args.post === 'string' && args.post.trim() !== '' ? args.post.trim() : null) ?? template?.post ?? null
    const duty = (args && typeof args.duty === 'string' && args.duty.trim() !== '' ? args.duty.trim() : null) ?? template?.duty ?? null
    if (!post || !duty) throw new Error('post 与 duty 必填，或改用 template 选择岗位模板')
    const model = args && typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : null
    const now = new Date().toISOString()
    //11.0 工位绑定：显式传入则覆盖，未传则保留既有绑定，避免更新档案时丢掉 teammate 关联
    const memberArg = args && typeof args.member === 'string' && args.member.trim() !== '' ? args.member.trim() : null
    let created = false
    //11.1 锁内字段合并：读取最新名册后只覆盖岗位类字段，未传 model/member 一律沿用原值；
    //11.1.1 sessionId/workspace/boundAt 等绑定态字段用展开保留，二次 hire 不再把工位会话清空（A-06）
    await rosterStore.mutate((roster) => {
      if (!roster.employees || typeof roster.employees !== 'object') roster.employees = {}
      //11.1.2 大小写查重：Windows/NTFS 路径大小写不敏感，Ann 与 ann 会落到同一个工位目录，
      //        两条档案互相覆盖知识库（qa 实测 case.txt 被后写的覆盖），所以入册前先查同形名
      const lower = name.toLowerCase()
      for (const other of Object.keys(roster.employees || {})) {
        if (other !== name && other.toLowerCase() === lower) {
          throw new Error('已有员工「' + other + '」与本名仅大小写不同，会共用工位目录互相覆盖；请换一个名字')
        }
      }
      const existing = roster.employees[name]
      created = !existing
      const record = existing && typeof existing === 'object' ? existing : {}
      roster.employees[name] = {
        ...record,
        post,
        duty,
        model: model ?? record.model ?? null,
        member: memberArg ?? record.member ?? null,
        status: 'active',
        hiredAt: record.hiredAt ?? now,
        updatedAt: now,
        todos: Array.isArray(record.todos) ? record.todos : [],
      }
    })
    const message = created
      ? `已招募员工「${name}」，岗位：${post}。名册已落盘。`
      : `已更新员工「${name}」档案，岗位：${post}，既有任务保留。`
    log('info', created ? '员工入职' : '员工档案更新', { name, post })
    return { name, post, created, message }
  },
}

//12. 花名册工具：默认只列在职员工，可选包含已离职，便于随时确认编制
const listTool = {
  name: 'staff_list',
  description: '列出当前在册员工及其任务计数。默认只显示在职员工。',
  parameters: {
    type: 'object',
    properties: {
      includeArchived: { type: 'boolean', description: '是否包含已离职员工，默认 false' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        text: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : '名册为空' }]
    },
  },
  async execute(args) {
    const includeArchived = args && args.includeArchived === true
    const roster = await readRoster()
    //12.1 过滤离职员工并按姓名排序，保证每次输出顺序稳定
    const rows = Object.entries(roster.employees)
      .filter(([, record]) => includeArchived || (record.status ?? 'active') === 'active')
      .map(([name, record]) => employeeView(name, record))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const text = renderRoster(rows)
    log('info', '花名册查询', { total: rows.length, includeArchived })
    return { total: rows.length, text }
  },
}

//13. 详情工具：给单员工档案 + 任务明细，派活前先看边界时使用
const showTool = {
  name: 'staff_show',
  description: '查看单名员工的档案与全部任务明细。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '员工姓名' } },
    required: ['name'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, text: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : `未找到员工 ${args.name}` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '员工姓名')
    const roster = await readRoster()
    const record = roster.employees[name]
    if (!record) throw new Error(`名册中没有员工「${name}」，先用 staff_list 确认编制`)
    log('info', '员工详情查询', { name })
    return { name, text: renderEmployee(employeeView(name, record), record) }
  },
}

//14. 派活工具：把任务写进该员工待办账本，返回任务号，供后续状态流转
const assignTool = {
  name: 'staff_assign',
  description: '向员工派发一条任务，写入其待办账本并返回任务号。只记账，不负责唤醒执行。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '员工姓名' },
      task: { type: 'string', description: '任务内容，写清交付物与验收标准' },
      acceptance: { type: 'string', description: '可选：验收方式，例如要跑哪条命令、看哪个证据' },
      priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '可选：优先级，默认 normal' },
      due: { type: 'string', description: '可选：截止日期，ISO 日期如 2026-10-30 或完整时间' },
    },
    required: ['name', 'task'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        taskId: { type: 'string' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : `已派活给 ${args.name}` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '员工姓名')
    const task = requireText(args, 'task', '任务内容')
    const acceptance = args && typeof args.acceptance === 'string' ? args.acceptance.trim() : ''
    //14.0 优先级与截止日期：可选，但一旦给了就要能被看板聚合，所以统一转小写并校验
    const priorityRaw = args && typeof args.priority === 'string' ? args.priority.trim().toLowerCase() : ''
    const priority = priorityRaw === '' ? 'normal' : priorityRaw
    if (!['high', 'normal', 'low'].includes(priority)) throw new Error(`priority 只能是 high/normal/low，收到 ${priority}`)
    const dueRaw = args && typeof args.due === 'string' ? args.due.trim() : ''
    let due = null
    if (dueRaw !== '') {
      const parsed = new Date(dueRaw)
      if (Number.isNaN(parsed.getTime())) throw new Error(`due 不是合法日期：${dueRaw}`)
      due = parsed.toISOString()
    }
    const roster = await readRoster()
    const record = roster.employees[name]
    if (!record) throw new Error(`名册中没有员工「${name}」，先 staff_hire 或确认姓名`)
    if ((record.status ?? 'active') !== 'active') throw new Error(`员工「${name}」已离职，不能派活`)
    const now = new Date().toISOString()
    //14.1 任务条目只存必要字段，验收标准随任务一起落盘，避免口头约定丢失
    const taskId = nextTaskId()
    record.todos = Array.isArray(record.todos) ? record.todos : []
    record.todos.push({ id: taskId, text: task, acceptance: acceptance || null, priority, due, status: 'todo', createdAt: now, updatedAt: now })
    record.updatedAt = now
    await writeRoster(roster)
    log('info', '任务派发', { name, taskId, priority, due })
    const dueNote = due ? `，截止 ${due.slice(0, 10)}` : ''
    return { name, taskId, message: `已派活给「${name}」，任务号 ${taskId}，优先级 ${priority}${dueNote}。记账完成，执行需另行唤醒。` }
  },
}

//15. 状态流转工具：任务在待办/进行/完成/阻塞之间切换，完成时保留时间戳
const taskUpdateTool = {
  name: 'staff_task_update',
  description: '更新某条员工任务的状态：todo 待办、doing 进行中、done 完成、blocked 阻塞。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '员工姓名' },
      taskId: { type: 'string', description: '任务号，例如 t-abc-1f2e' },
      status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'], description: '目标状态' },
      note: { type: 'string', description: '可选：变更说明，例如阻塞原因或验收证据' },
    },
    required: ['name', 'taskId', 'status'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        taskId: { type: 'string' },
        status: { type: 'string' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : `任务 ${args.taskId} 已更新` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '员工姓名')
    const taskId = requireText(args, 'taskId', '任务号')
    const status = requireText(args, 'status', '目标状态')
    if (!TASK_STATUS.has(status)) throw new Error(`状态必须是 todo/doing/done/blocked 之一，收到 ${status}`)
    const note = args && typeof args.note === 'string' ? args.note.trim() : ''
    const roster = await readRoster()
    const record = roster.employees[name]
    if (!record) throw new Error(`名册中没有员工「${name}」`)
    const todos = Array.isArray(record.todos) ? record.todos : []
    const target = todos.find((item) => item.id === taskId)
    if (!target) throw new Error(`员工「${name}」名下没有任务 ${taskId}`)
    const now = new Date().toISOString()
    //15.1 状态与说明同时更新，完成时间单独记，便于后续算工时
    target.status = status
    target.note = note || target.note || null
    target.updatedAt = now
    if (status === 'done') target.doneAt = now
    //15.2 置 doing 必须同时补派发时间：doctor 靠它区分「真的在跑」与「状态被手改」，否则误报进行中无派发记录（D-05）
    if (status === 'doing') target.dispatchedAt = now
    record.updatedAt = now
    await writeRoster(roster)
    log('info', '任务状态变更', { name, taskId, status })
    return { name, taskId, status, message: `任务 ${taskId}（${name}）已置为 ${status}。` }
  },
}

//16. 离职工具：软删除，保留任务历史供复盘，不物理删除记录
const fireTool = {
  name: 'staff_fire',
  description: '让员工离职：状态置为 archived，保留历史任务与档案，不做物理删除。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '员工姓名' } },
    required: ['name'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, message: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : `员工 ${args.name} 已离职` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '员工姓名')
    //16.1.1 名册离职标记与群成员清理放进同一事务：任一步读失败或写失败，两个文件都保持原样（P0-3 收口）
    const outcome = await mutateMany(['roster', 'groups'], (dataMap) => {
      const roster = dataMap.roster
      const stores = dataMap.groups
      const record = roster.employees[name]
      if (!record) throw new Error(`名册中没有员工「${name}」`)
      record.status = 'archived'
      record.updatedAt = new Date().toISOString()
      const removedFrom = []
      const dissolved = []
      for (const [groupId, group] of Object.entries(stores.groups || {})) {
        const members = Array.isArray(group.members) ? group.members : []
        if (members.indexOf(name) < 0) continue
        const next = members.filter((item) => item !== name)
        //16.1.2 剩余不足 2 人的群已无协作意义，直接解散并在结果里说明
        if (next.length < 2) {
          delete stores.groups[groupId]
          dissolved.push(group.name)
        } else {
          group.members = next
          removedFrom.push(group.name)
        }
      }
      return { removedFrom, dissolved }
    })
    const removedFrom = outcome.removedFrom
    const dissolved = outcome.dissolved
    log('info', '员工离职', {
      name,
      removedFrom: removedFrom.join(',') || '-',
      dissolved: dissolved.join(',') || '-',
    })
    const parts = [`「${name}」已离职，档案与任务历史保留。`]
    if (removedFrom.length > 0) parts.push(`已从群移出：${removedFrom.join('、')}`)
    if (dissolved.length > 0) parts.push(`因人数不足已解散：${dissolved.join('、')}`)
    return { name, message: parts.join(' ') }
  },
}

//17. 运行时上下文引用：apply 时保存，供群消息投递时解析 Agent Teams 服务
let hostCtx = null

//17.1 解析发送者身份：优先用 Agent Teams 的成员名，解析失败才回退 lead，避免群记录把员工发言记成老板
function resolveSender(exec) {
  if (!hostCtx || typeof hostCtx.get !== 'function') return 'lead'
  const teams = hostCtx.get('agentTeams')
  if (!teams || typeof teams.membership !== 'function') return 'lead'
  try {
    const membership = teams.membership(exec.agent)
    if (membership && typeof membership.name === 'string' && membership.name !== '') return membership.name
  } catch (error) {
    log('warn', '发送者身份解析失败，回退 lead', error instanceof Error ? error.message : String(error))
  }
  return 'lead'
}

//17.3 构造群消息信封：投递时附带群内最近若干条，让成员看见彼此的发言
//     注：不改会话消息结构（不构造 UserMessage），只在投递内容里捎带上下文，避免污染会话日志
function buildGroupEnvelope(group, sender, text, seq, recipient) {
  //17.3.1 历史窗口放大到 15 条：技术档案、决策结论这类长消息要能多留一会儿
  const history = (group.messages ?? []).slice(-15, -1)
  const lines = []
  lines.push(`【群「${group.name}」· 群 ID ${group.id}】`)
  if (history.length > 0) {
    lines.push('【近期群内发言】')
    for (const item of history) {
      lines.push(`#${item.seq} ${item.from}${item.mention ? ' @' + item.mention : ''}: ${item.text}`)
    }
  } else {
    lines.push('【近期群内发言】暂无（你是第一个收到本群消息的人）')
  }
  lines.push('')
  lines.push(`【本条 #${seq} 由 ${sender} 发出】${text}`)
  //17.3.2 秘书视角：老板只把话交给她，分派责任也在她
  if (recipient && group.secretary && group.secretary === recipient) {
    lines.push('')
    lines.push('【你是本群秘书 · 老板的话只到你这里】')
    lines.push('1. 先判断这件事该谁做：需要具体成员执行的，用 group_send（带 mention 点名）转给他，并在正文里说清要他交付什么；')
    lines.push('2. 自己能答的（进度汇总、状态说明、协调安排）就直接答，不要往下推诿；')
    lines.push('3. 分派后要用 staff_reply 把「已分派给谁、期待什么结果」写回群里，让老板看得见。')
    lines.push('4. 老板的每条发言都必须给回应：哪怕只是打招呼，也要回一句并说明是否已收到；没有需要分派时直接答，不要沉默。')
  }
  lines.push('')
  lines.push(`如需在群里发言，用 staff_reply（groupId=${group.id}）把内容写回群消息流，老板能在界面直接看到；也可以用 group_send 投递给个别同事。回复时请注明你在回应哪一条 #序号。只写你自己的回答，不要把老板的原话复述一遍再署自己的名。`)
  return lines.join('\n')
}

//17.3.9 反查 teammate 所在的会话：群是全局的，teammate 是会话内实体，投递必须落到它真正待的那个会话
function findLeadOfMember(agents, teams, memberName) {
  if (!agents || !teams || typeof agents.roots !== 'function') return null
  let roots = []
  try { roots = agents.roots() } catch (error) { return null }
  for (const root of roots) {
    const lead = agents.get ? agents.get(root.id) : root
    if (!lead) continue
    try {
      const members = teams.listMembers(lead)
      if (members.some((item) => item.name === memberName)) return lead
    } catch (error) { /* 该会话不可查则跳过 */ }
  }
  return null
}

//17.4.5.1 重建工位选最空闲的会话：teammate 占会话成员名额，重建时别把新成员硬塞进已经很挤的会话
//17.4.5.2 取不到会话列表就退回调用方，保持原有行为，不因为挑会话失败而投递失败
function pickLeastLoadedLead(agentsSvc, teams, fallback) {
  if (!agentsSvc || typeof agentsSvc.roots !== 'function' || typeof teams.listMembers !== 'function') return fallback
  let best = fallback
  let bestCount = Infinity
  try {
    for (const root of agentsSvc.roots()) {
      const lead = agentsSvc.get ? agentsSvc.get(root.id) : root
      if (!lead) continue
      let count
      try {
        count = teams.listMembers(lead).length
      } catch (error) {
        continue
      }
      if (count < bestCount) { best = lead; bestCount = count }
    }
  } catch (error) {
    return fallback
  }
  return best || fallback
}

//17.4.6 工位自愈：成员在当前会话不存在时，按名册重建工位，并把这条消息作为初始口令投递
//17.4.6.1 只给「私聊」这类明确单目标投递开自愈；群发人群不确定，一次失败不该悄悄造出 N 个 teammate
async function reviveMember(teams, caller, memberName, record, text) {
  if (!teams || typeof teams.spawnTeammate !== 'function') return { ok: false, reason: 'Agent Teams 不支持重建工位' }
  if (!caller) return { ok: false, reason: '没有可用的投递凭据' }
  try {
    const spawned = await teams.spawnTeammate(caller, {
      name: memberName,
      description: (record && record.post) || memberName,
      prompt: [{ type: 'text', text }],
      context: 'fresh',
      provider: TEAMMATE_PROVIDER,
      signal: new AbortController().signal,
    })
    const created = spawned && spawned.member
    if (!created) return { ok: false, reason: '重建未返回成员' }
    //17.4.6.2 创建成功不等于能用：provider 无 adapter 时会立即 failed，必须回传诊断而不是假装送达
    if (created.status === 'failed') {
      const detail = Array.isArray(created.diagnostics) && created.diagnostics.length > 0
        ? created.diagnostics.join('；')
        : 'provider ' + (created.provider || TEAMMATE_PROVIDER)
      return { ok: false, reason: detail }
    }
    log('info', '工位已重建并完成投递', { memberName, provider: created.provider || TEAMMATE_PROVIDER })
    return { ok: true, provider: created.provider || TEAMMATE_PROVIDER }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

//17.4 投递一条群消息到某个 teammate：失败只记录原因，不阻断群消息落盘
async function deliverToMember(exec, memberName, text, options) {
  if (!hostCtx) return { member: memberName, ok: false, reason: '插件未激活' }
  const teams = typeof hostCtx.get === 'function' ? hostCtx.get('agentTeams') : undefined
  if (!teams) return { member: memberName, ok: false, reason: 'Agent Teams 未启用' }
  //17.4.1 优先用目标员工所在的会话作为投递凭据；找不到才退回当前会话
  const agentsSvc = typeof hostCtx.get === 'function' ? hostCtx.get('agents') : undefined
  //17.4.5 D-03 修复：优先使用名册里绑定的上下文会话，绑定才真正生效；无绑定再回退专属会话/自动查找
  let boundLead = null
  if (agentsSvc && typeof agentsSvc.get === 'function') {
    const rosterForBind = await readRoster()
    for (const item of Object.values(rosterForBind.employees)) {
      if (item.member === memberName && item.sessionId) {
        try { boundLead = agentsSvc.get(item.sessionId) } catch (error) { boundLead = null }
        break
      }
    }
  }
  const staffLead = boundLead ? null : await ensureStaffSession(agentsSvc, memberName)
  const ownerLead = boundLead || staffLead || findLeadOfMember(agentsSvc, teams, memberName)
  const caller = ownerLead || exec.agent
  if (!caller) return { member: memberName, ok: false, reason: '没有可用的投递凭据' }
  //17.4.2 已知坏工位默认跳过；但「成员不存在」属于工位缺失，允许重建自愈（17.4.6），不能永久拉黑
  const broken = await readBroken()
  const knownBroken = broken.members ? broken.members[memberName] : undefined
  const brokenMissing = knownBroken ? isMissingMemberReason(knownBroken.reason) : false
  if (knownBroken && !brokenMissing) {
    return { member: memberName, ok: false, reason: '该工位已判定不可用（' + knownBroken.reason + '），需新会话重建' }
  }
  const allowRevive = !!(options && options.allowRevive)
  //17.4.7 在场判定靠 listMembers 取证而不是靠记录猜：成员不在团队里就没法 sendMessage
  let present = null
  if (typeof teams.listMembers === 'function') {
    try {
      present = teams.listMembers(caller).some((item) => item && item.name === memberName)
    } catch (error) {
      present = null
    }
  }
  //17.4.8 成员缺失且允许自愈：先按名册重建工位（消息作为初始口令直接投递），重建成功即视为送达
  if (present === false && allowRevive) {
    const reviveCaller = pickLeastLoadedLead(agentsSvc, teams, caller)
    const revived = await reviveMember(teams, reviveCaller, memberName, options && options.record, text)
    if (revived.ok) {
      await clearBroken(memberName)
      return { member: memberName, ok: true, repaired: true, provider: revived.provider }
    }
    return { member: memberName, ok: false, reason: '工位缺失且重建失败（' + revived.reason + '）；可在员工中心点「上线」后重试' }
  }
  try {
    //17.1.1 单目标投递：Agent Teams 原生只支持点对点，群发由上层循环实现
    await teams.sendMessage(caller, {
      target: memberName,
      content: [{ type: 'text', text }],
      signal: exec.signal,
    })
    return { member: memberName, ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    //17.4.3 失败即记入坏工位名单：不靠 status 预判，靠实际投递结果取证
    await markBroken(memberName, reason)
    return { member: memberName, ok: false, reason }
  }
}

//17.2 渲染投递结果：成功与失败分开列，避免把部分失败说成全部成功
function renderDelivery(results) {
  const ok = results.filter((item) => item.ok).map((item) => item.member)
  const failed = results.filter((item) => !item.ok)
  const lines = [`投递成功 ${ok.length} 人${ok.length ? '：' + ok.join('、') : ''}`]
  if (failed.length > 0) {
    lines.push(`投递失败 ${failed.length} 人：` + failed.map((item) => `${item.member}（${item.reason}）`).join('、'))
  }
  return lines.join('\n')
}

//18. 建群工具：一个群绑定一组在册员工，成员数限制 2–8，上限与 Agent Teams 的 8 人对齐
const groupCreateTool = {
  name: 'group_create',
  description: '创建一个群，把 2–8 名在册员工拉进同一个群消息流。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '群名称，例如「大模型选型讨论」' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: '成员姓名数组，必须是已入职员工，2–8 人',
      },
      workspace: {
        type: 'string',
        description: '可选：本群绑定的工作区绝对路径，例如 E:/DSH；后续在该群发言默认归属此工作区',
      },
      secretary: {
        type: 'string',
        description: '可选：本群秘书姓名，老板发言只投递给此人，由她再分派给其他成员',
      },
    },
    required: ['name', 'members'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        name: { type: 'string' },
        memberCount: { type: 'number' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : `群 ${args.name} 已创建` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '群名称')
    const members = Array.isArray(args && args.members) ? args.members.map((item) => String(item).trim()).filter(Boolean) : []
    if (members.length < 2 || members.length > 8) throw new Error(`群成员必须是 2–8 人，收到 ${members.length} 人`)
    const roster = await readRoster()
    //18.1 成员必须是已入职且在职的员工，避免把不存在的人拉进群
    const missing = members.filter((item) => !roster.employees[item] || (roster.employees[item].status ?? 'active') !== 'active')
    if (missing.length > 0) throw new Error(`以下人员未入职或已离职：${missing.join('、')}`)
    const store = await readGroups()
    const groupId = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    //18.2 工作区：群里发言的默认归属目录，按天切换会话时用它创建新任务
    const workspace = args && typeof args.workspace === 'string' ? args.workspace.trim() : ''
    //18.3 秘书必须是本群成员，否则消息中转会落到不存在的人身上
    const secretary = args && typeof args.secretary === 'string' ? args.secretary.trim() : ''
    const uniqueMembers = [...new Set(members)]
    if (secretary !== '' && uniqueMembers.indexOf(secretary) < 0) {
      throw new Error(`秘书「${secretary}」不在群成员里，请先加入该群再设为秘书`)
    }
    store.groups[groupId] = {
      id: groupId,
      name,
      members: [...new Set(members)],
      messages: [],
      seq: 0,
      workspace: workspace || null,
      secretary: secretary || null,
      dayAnchor: currentDayKey(),
      createdAt: new Date().toISOString(),
    }
    await writeGroups(store)
    log('info', '群创建', { groupId, name, members })
    return { groupId, name, memberCount: members.length, message: `群「${name}」已创建（${members.length} 人），群 ID：${groupId}。` }
  },
}

//18.1 群设置工具：增删成员或改名，成员数量仍受 2–8 限制
//18.0.1 解散群：从存储中移除该群及其消息，需要 confirm=true 防止误删
const groupDeleteTool = {
  name: 'group_delete',
  description: '解散一个群：把群从存储中删除，成员与消息一并清除，不可恢复。',
  parameters: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: '要解散的群 ID' },
      confirm: { type: 'boolean', description: '必须传 true 才执行，防止误删' },
    },
    required: ['groupId', 'confirm'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' }, message: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : '群已解散' }]
    },
  },
  async execute(args) {
    const groupId = requireText(args, 'groupId', '群 ID')
    if (!args || args.confirm !== true) throw new Error('解散群需要 confirm: true')
    const store = await readGroups()
    const group = store.groups[groupId]
    if (!group) throw new Error(`群 ${groupId} 不存在`)
    const groupName = group.name
    const messageCount = Array.isArray(group.messages) ? group.messages.length : 0
    delete store.groups[groupId]
    await writeGroups(store)
    log('info', '群已解散', { groupId, groupName, messages: messageCount })
    return { deleted: true, message: `群「${groupName}」已解散（含 ${messageCount} 条消息）` }
  },
}

const groupUpdateTool = {
  name: 'group_update',
  description: '调整群设置：增删成员或改名。成员数量仍限定 2–8 人。',
  parameters: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: '群 ID' },
      name: { type: 'string', description: '可选：新群名' },
      addMembers: { type: 'array', items: { type: 'string' }, description: '可选：要加入的成员姓名数组' },
      removeMembers: { type: 'array', items: { type: 'string' }, description: '可选：要移出的成员姓名数组' },
      workspace: { type: 'string', description: '可选：改绑本群的工作区绝对路径' },
      secretary: { type: 'string', description: '可选：改设本群秘书，传空串表示取消中转' },
    },
    required: ['groupId'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        groupId: { type: 'string' },
        members: { type: 'string' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : '群已更新' }]
    },
  },
  async execute(args) {
    const groupId = requireText(args, 'groupId', '群 ID')
    const store = await readGroups()
    const group = store.groups[groupId]
    if (!group) throw new Error(`群 ${groupId} 不存在`)
    const roster = await readRoster()
    const add = Array.isArray(args && args.addMembers) ? args.addMembers.map((item) => String(item).trim()).filter(Boolean) : []
    const remove = Array.isArray(args && args.removeMembers) ? args.removeMembers.map((item) => String(item).trim()).filter(Boolean) : []
    const newName = args && typeof args.name === 'string' ? args.name.trim() : ''
    //18.1.0 工作区改绑：传空串表示解除绑定
    const hasWorkspaceArg = args && typeof args.workspace === 'string'
    const newWorkspace = hasWorkspaceArg ? String(args.workspace).trim() : ''
    //18.1.5 秘书改设：空串表示取消中转，非空必须仍在群成员内
    const hasSecretaryArg = args && typeof args.secretary === 'string'
    const newSecretary = hasSecretaryArg ? String(args.secretary).trim() : ''
    //18.1.1 空变更直接拒绝，避免无意义写盘
    if (add.length === 0 && remove.length === 0 && newName === '' && !hasWorkspaceArg && !hasSecretaryArg) {
      throw new Error('没有要变更的内容：name / addMembers / removeMembers / workspace / secretary 至少给一个')
    }
    //18.1.2 新增成员必须在册且在职，防止把不存在的人拉进群
    const invalid = add.filter((item) => !roster.employees[item] || (roster.employees[item].status ?? 'active') !== 'active')
    if (invalid.length > 0) throw new Error(`以下人员未入职或已离职：${invalid.join('、')}`)
    let members = Array.isArray(group.members) ? group.members.slice() : []
    members = members.filter((item) => !remove.includes(item))
    members = [...new Set([...members, ...add])]
    if (members.length < 2 || members.length > 8) throw new Error(`群成员必须是 2–8 人，变更后为 ${members.length} 人`)
    if (newName !== '') group.name = newName
    if (hasWorkspaceArg) group.workspace = newWorkspace === '' ? null : newWorkspace
    //18.1.6 秘书校验放在成员变更之后，允许同时踢人并改秘书
    if (hasSecretaryArg) {
      if (newSecretary !== '' && members.indexOf(newSecretary) < 0) {
        throw new Error(`秘书「${newSecretary}」不在群成员里，请先加入该群再设为秘书`)
      }
      group.secretary = newSecretary === '' ? null : newSecretary
    }
    group.members = members
    group.updatedAt = new Date().toISOString()
    await writeGroups(store)
    log('info', '群设置变更', { groupId, name: group.name, members })
    return {
      groupId,
      members: members.join('、'),
      message: `群已更新：名称「${group.name}」，成员 ${members.length} 人（${members.join('、')}）。`,
    }
  },
}

//19. 群发言工具：先把消息落盘，再按点名或全员投递，投递失败不丢消息
const groupSendTool = {
  name: 'group_send',
  description: '在群里发言一条消息，并投递给点名成员或全体成员。消息先落盘，投递尽力而为。',
  parameters: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: '群 ID，例如 g-abc-1f2e' },
      text: { type: 'string', description: '发言内容' },
      mention: { type: 'string', description: '可选：只投递给这一名员工（按姓名），不传则投给全员' },
    },
    required: ['groupId', 'text'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        seq: { type: 'number' },
        delivered: { type: 'number' },
        failed: { type: 'number' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : '群消息已发送' }]
    },
  },
  async execute(args, exec) {
    const groupId = requireText(args, 'groupId', '群 ID')
    const text = requireText(args, 'text', '发言内容')
    const mention = args && typeof args.mention === 'string' && args.mention.trim() !== '' ? args.mention.trim() : null
    //19.1 锁内认领并落盘：读-改-写整段进锁，并发发言不会互相覆盖；投递是后置动作，任何投递异常都不能导致消息丢失
    const sender = resolveSender(exec)
    //19.1.0 点名准入：mention 必须是本群在职成员；校验放在锁内、落盘之前，不合法直接抛错，消息一条都不写（D-06）
    const roster = await readRoster()
    let group = null
    await groupsStore.mutate((store) => {
      if (!store.groups || typeof store.groups !== 'object') store.groups = {}
      const target = store.groups[groupId]
      if (!target) throw new Error(`群 ${groupId} 不存在，先用 group_list 确认`)
      if (mention) {
        const groupMembers = Array.isArray(target.members) ? target.members : []
        if (!groupMembers.includes(mention)) throw new Error(`「${mention}」不是群「${target.name ?? groupId}」的成员，不能点名；先 group_update 把 ta 加进群`)
        const mentioned = roster.employees[mention]
        if (!mentioned) throw new Error(`名册中没有员工「${mention}」，不能点名`)
        if ((mentioned.status ?? 'active') !== 'active') throw new Error(`员工「${mention}」已离职，不能点名`)
      }
      if (!Array.isArray(target.messages)) target.messages = []
      target.seq = (target.seq ?? 0) + 1
      target.messages.push({ seq: target.seq, from: sender, text, mention, ts: new Date().toISOString(), dayKey: currentDayKey() })
      //19.1.1 单群消息上限：超限丢最旧并记裁剪时间，避免群文件无限膨胀拖慢读取（A-11）
      if (target.messages.length > GROUP_MESSAGE_LIMIT) {
        target.messages = target.messages.slice(-GROUP_MESSAGE_LIMIT)
        target.trimmedAt = new Date().toISOString()
      }
      group = target
    })
    //19.2 点名只投一人；老板发言且群设了秘书时只投秘书，其余情况投全员
    const bossMessage = sender === 'lead'
    //19.2.1 全员投递排除已离职：archived 的人仍留在 members 里，但不能再收消息、更不能被唤醒
    const activeMembers = (Array.isArray(group.members) ? group.members : []).filter((member) => {
      const record = roster.employees[member]
      return Boolean(record) && (record.status ?? 'active') === 'active'
    })
    //19.2.2 秘书同样要校验在职：已离职的秘书不能继续当中转，否则老板的发言全打进黑洞
    const secretaryRecord = group.secretary ? roster.employees[group.secretary] : null
    const secretaryUsable = Boolean(secretaryRecord) && (secretaryRecord.status ?? 'active') === 'active'
    const targets = mention
      ? [mention]
      : (bossMessage && secretaryUsable ? [group.secretary] : activeMembers)
    //19.4 已移除「发言前自动拉起秘书」：坏了却没被标记 failed 的 agent 会被反复唤醒，
    //19.4.1 status 显示 inactive 但实际执行失败时无法识别，因此改为完全由用户点「上线」控制
    //19.4.2 名册已在 19.1.0 点名准入时读过，这里直接复用，避免同一请求读两遍名册
    //19.5 失败成员不再投递：投了也只会再失败一次，还会把失败通知刷给老板
    const failedMembers = new Set()
    if (hostCtx) {
      const teamsForStatus = typeof hostCtx.get === 'function' ? hostCtx.get('agentTeams') : undefined
      if (teamsForStatus && exec && exec.agent) {
        try {
          for (const item of teamsForStatus.listMembers(exec.agent)) {
            if (item.status === 'failed') failedMembers.add(item.name)
          }
        } catch (error) { /* 拿不到状态就按原逻辑投递 */ }
      }
    }
    const results = []
    let skipped = 0
    for (const target of targets) {
      const record = roster.employees[target]
      const memberName = record && record.member ? record.member : null
      if (!memberName) {
        results.push({ member: target, ok: false, reason: '未绑定 teammate，先 staff_hire 传 member' })
        continue
      }
      //19.3 发送者本人不需要收自己的群消息，直接跳过，避免产生无意义的投递失败
      if (memberName === sender) {
        skipped += 1
        continue
      }
      //19.6 该员工位处于失败态，跳过投递并在结果里标注，避免反复触发坏 agent
      if (failedMembers.has(memberName)) {
        results.push({ member: target, ok: false, reason: '该员工位当前为失败态，已跳过（需新会话重建）' })
        continue
      }
      results.push(await deliverToMember(exec, memberName, buildGroupEnvelope(group, sender, text, group.seq, target)))
    }
    const delivered = results.filter((item) => item.ok).length
    const failed = results.length - delivered
    log('info', '群消息发送', { groupId, seq: group.seq, sender, delivered, failed, skipped })
    return {
      seq: group.seq,
      delivered,
      failed,
      message: `群消息 #${group.seq} 已落盘，发送者 ${sender}。\n${renderDelivery(results)}${skipped > 0 ? `\n已跳过发送者本人 ${skipped} 人` : ''}`,
    }
  },
}

//20. 读群工具：按序号返回最近消息，供人和模型回看群历史
const groupReadTool = {
  name: 'group_read',
  description: '读取群消息流，默认返回最近 20 条。',
  parameters: {
    type: 'object',
    properties: {
      groupId: { type: 'string', description: '群 ID' },
      limit: { type: 'number', description: '返回条数，默认 20，最大 200' },
    },
    required: ['groupId'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { groupId: { type: 'string' }, text: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : `群 ${args.groupId} 暂无消息` }]
    },
  },
  async execute(args) {
    const groupId = requireText(args, 'groupId', '群 ID')
    const rawLimit = args && typeof args.limit === 'number' ? Math.floor(args.limit) : 20
    const limit = Math.min(Math.max(rawLimit, 1), 200)
    const store = await readGroups()
    const group = store.groups[groupId]
    if (!group) throw new Error(`群 ${groupId} 不存在`)
    const messages = Array.isArray(group.messages) ? group.messages.slice(-limit) : []
    if (messages.length === 0) return { groupId, text: `群「${group.name}」暂无消息。` }
    //20.1 每条消息一行，带序号、发送者、时间与点名信息，便于追溯
    const lines = [`群「${group.name}」最近 ${messages.length} 条：`]
    for (const item of messages) {
      const mention = item.mention ? ` @${item.mention}` : ''
      lines.push(`#${item.seq} [${item.ts}] ${item.from}${mention}: ${item.text}`)
    }
    return { groupId, text: lines.join('\n') }
  },
}

//21. 列群工具：查看当前所有群、成员与消息数
const groupListTool = {
  name: 'group_list',
  description: '列出当前所有群及其成员规模与消息数。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: { total: { type: 'number' }, text: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : '当前没有群' }]
    },
  },
  async execute() {
    const store = await readGroups()
    const rows = Object.values(store.groups)
    if (rows.length === 0) return { total: 0, text: '当前没有群。用 group_create 建第一个群。' }
    const header = '| 群 ID | 群名 | 成员 | 消息数 |'
    const divider = '| --- | --- | --- | --- |'
    const body = rows.map((group) => `| ${group.id} | ${group.name} | ${(group.members ?? []).join('、')} | ${(group.messages ?? []).length} |`)
    return { total: rows.length, text: [header, divider, ...body].join('\n') }
  },
}

//21.1 构造工单信封：一条投递里带上该员工名下所有待办，减少唤醒次数
function buildTaskEnvelope(employeeName, post, todos) {
  const lines = [`【工单 → ${employeeName}${post ? '（' + post + '）' : ''}】`]
  for (const item of todos) {
    lines.push(`- ${item.id}：${item.text}`)
    if (item.acceptance) lines.push(`  验收：${item.acceptance}`)
  }
  lines.push('')
  lines.push('完成后调用 staff_task_update 把对应任务置为 done，并 send_message 回报 lead。')
  return lines.join('\n')
}

//21.2 批量派发工具：把员工名下所有待办投给对应 teammate 并唤醒，是「员工自己开工」的最小形态
//      不做后台定时器：唤醒会真实计费，必须由人显式触发
const dispatchTool = {
  name: 'staff_dispatch',
  description: '把员工名下所有待办任务批量投递给对应 teammate 并唤醒执行。只处理已绑定 teammate 的在职员工。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '可选：只派发指定员工；不传则处理全部在职员工' },
      dryRun: { type: 'boolean', description: '可选：只列出将被派发的任务，不实际投递也不改状态' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        dispatched: { type: 'number' },
        skipped: { type: 'number' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : '派发完成' }]
    },
  },
  async execute(args, exec) {
    const only = args && typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
    const dryRun = args && args.dryRun === true
    const roster = await readRoster()
    const names = only ? [only] : Object.keys(roster.employees)
    const doneLines = []
    const skippedLines = []
    let dispatched = 0
    let attempted = 0
    for (const employeeName of names) {
      const record = roster.employees[employeeName]
      if (!record) { skippedLines.push(`${employeeName}：不在名册`); continue }
      if ((record.status ?? 'active') !== 'active') { skippedLines.push(`${employeeName}：已离职`); continue }
      const todos = (Array.isArray(record.todos) ? record.todos : []).filter((item) => item.status === 'todo')
      if (todos.length === 0) continue
      //21.2.1 未绑定 teammate 无法投递，列为跳过原因而不是静默忽略
      if (!record.member) { skippedLines.push(`${employeeName}：未绑定 teammate`); continue }
      if (dryRun) { doneLines.push(`[预演] ${employeeName}（${record.member}）：${todos.length} 条`); continue }
      attempted += 1
      const delivered = await deliverToMember(exec, record.member, buildTaskEnvelope(employeeName, record.post ?? '', todos))
      if (!delivered.ok) { skippedLines.push(`${employeeName}：投递失败（${delivered.reason}）`); continue }
      //21.2.2 投递成功才推进状态，避免投递失败却把任务标成进行中
      const now = new Date().toISOString()
      for (const item of todos) { item.status = 'doing'; item.dispatchedAt = now; item.updatedAt = now }
      dispatched += 1
      doneLines.push(`${employeeName}（${record.member}）：投递 ${todos.length} 条`)
    }
    if (!dryRun && dispatched > 0) await writeRoster(roster)
    log('info', '批量派发', { dispatched, skipped: skippedLines.length, dryRun })
    //21.2.3 全失败要单独说清：确实发起了投递却一条都没成功，不能回落成「没有可派发的待办」（D-08）
    const allFailed = !dryRun && attempted > 0 && dispatched === 0
    const summary = doneLines.length > 0
      ? doneLines.join('\n')
      : (allFailed
        ? `全部失败：${attempted} 名员工的待办均未投递成功，逐人原因见下方。`
        : '没有可派发的待办。')
    const suffix = skippedLines.length > 0 ? `\n\n跳过：\n${skippedLines.join('\n')}` : ''
    return { dispatched, skipped: skippedLines.length, message: `${dryRun ? '【预演模式】' : ''}${summary}${suffix}` }
  },
}

//21.4 看板工具：一次输出名册、待办、群与状态的全景，替代暂未实现的可视化面板
const dashboardTool = {
  name: 'staff_dashboard',
  description: '输出员工制看板：全部员工的岗位、状态、待办分布与群消息概况。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: {
        employees: { type: 'number' },
        groups: { type: 'number' },
        text: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : '看板为空' }]
    },
  },
  async execute() {
    const roster = await readRoster()
    const stores = await readGroups()
    const employeeRows = Object.entries(roster.employees)
    const groupRows = Object.values(stores.groups)
    //21.4.1 顶部先给汇总，避免读者在大表里找结论
    const totalTodo = employeeRows.reduce((sum, [, r]) => sum + (r.todos ?? []).filter((t) => t.status === 'todo').length, 0)
    const totalDoing = employeeRows.reduce((sum, [, r]) => sum + (r.todos ?? []).filter((t) => t.status === 'doing').length, 0)
    const totalBlocked = employeeRows.reduce((sum, [, r]) => sum + (r.todos ?? []).filter((t) => t.status === 'blocked').length, 0)
    const lines = [
      '## 员工制看板',
      `员工 ${employeeRows.length} 人 · 群 ${groupRows.length} 个 · 待办 ${totalTodo} · 进行 ${totalDoing} · 阻塞 ${totalBlocked}`,
      '',
      '### 员工',
      '| 姓名 | 岗位 | 状态 | 工位 | 待办 | 进行 | 完成 | 阻塞 | 逾期 | 高优 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    if (employeeRows.length === 0) {
      lines.push('| — | 暂无在册员工 | — | — | — | — | — | — | — | — |')
    } else {
      const nowMs = Date.now()
      for (const [name, record] of employeeRows.sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
        const todos = Array.isArray(record.todos) ? record.todos : []
        const count = (status) => todos.filter((item) => item.status === status).length
        //21.4.3 逾期只统计未完成任务；高优单独计，两者不互斥
        const overdue = todos.filter((item) => item.status !== 'done' && item.due && new Date(item.due).getTime() < nowMs).length
        const urgent = todos.filter((item) => item.status !== 'done' && item.priority === 'high').length
        lines.push(`| ${name} | ${record.post ?? ''} | ${record.status ?? 'active'} | ${record.member ?? '未绑定'} | ${count('todo')} | ${count('doing')} | ${count('done')} | ${count('blocked')} | ${overdue} | ${urgent} |`)
      }
    }
    lines.push('', '### 群')
    if (groupRows.length === 0) {
      lines.push('暂无群。')
    } else {
      lines.push('| 群名 | 成员 | 消息数 | 最近一条 |')
      lines.push('| --- | --- | --- | --- |')
      for (const group of groupRows) {
        const last = (group.messages ?? []).slice(-1)[0]
        const lastText = last ? `#${last.seq} ${last.from}: ${String(last.text).slice(0, 24)}` : '—'
        lines.push(`| ${group.name} | ${(group.members ?? []).join('、')} | ${(group.messages ?? []).length} | ${lastText} |`)
      }
    }
    //21.4.2 阻塞项单独列出，这是最需要人介入的部分
    const blocked = []
    for (const [name, record] of employeeRows) {
      for (const item of record.todos ?? []) {
        if (item.status === 'blocked') blocked.push(`${name} / ${item.id}：${item.text}${item.note ? '（' + item.note + '）' : ''}`)
      }
    }
    if (blocked.length > 0) {
      lines.push('', '### 阻塞待处理')
      for (const item of blocked) lines.push(`- ${item}`)
    }
    //21.4.4 逾期与高优单独列：这是每天最先要看的，不该埋在表里
    const nowMs = Date.now()
    const urgentList = []
    for (const [name, record] of employeeRows) {
      for (const item of record.todos ?? []) {
        if (item.status === 'done') continue
        const overdue = Boolean(item.due) && new Date(item.due).getTime() < nowMs
        if (!overdue && item.priority !== 'high') continue
        const tag = [overdue ? '逾期' : '', item.priority === 'high' ? '高优' : ''].filter(Boolean).join('/')
        const dueNote = item.due ? `，截止 ${String(item.due).slice(0, 10)}` : ''
        urgentList.push(`${name} / ${item.id}：${item.text}${dueNote} [${tag}]`)
      }
    }
    if (urgentList.length > 0) {
      lines.push('', '### 需优先处理')
      for (const item of urgentList) lines.push(`- ${item}`)
    }
    return { employees: employeeRows.length, groups: groupRows.length, text: lines.join('\n') }
  },
}

//21.5 员工交接单：把档案还原成可复制的 spawn 参数，解决「换会话后员工没了」的重建成本
const rebuildTool = {
  name: 'staff_rebuild',
  description: '生成员工交接单：把档案还原成 spawn_teammate 可直接使用的参数，用于在新会话重建员工。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '员工姓名' } },
    required: ['name'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, text: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : `未找到员工 ${args.name}` }]
    },
  },
  async execute(args) {
    const name = requireText(args, 'name', '员工姓名')
    const roster = await readRoster()
    const record = roster.employees[name]
    if (!record) throw new Error(`名册中没有员工「${name}」`)
    const member = record.member || name
    //21.5.1 交接单只包含可复用信息，不写任务历史，避免把旧上下文带进新会话
    const lines = [
      `## 员工交接单：${name}`,
      '',
      '在新会话中重建这名员工，把下面的参数原样传给 `spawn_teammate`：',
      '',
      '- **name**：`' + member + '`',
      '- **description**：' + (record.post ?? ''),
      '- **context**：fresh',
      '',
      '**prompt**：',
      '',
      '```text',
      `你是${name}，岗位：${record.post ?? ''}。`,
      '',
      '【岗位说明书】',
      record.duty ?? '',
      '',
      '【工作方式】',
      '1. 接到任务先复述理解，再动手。',
      '2. 不确定就说不确定，严禁编造数据与来源。',
      '3. 完成后用 send_message 回报 lead，说明结论、证据、剩余风险。',
      '```',
      '',
      '重建后再执行一次 `staff_hire`，`name` 填 ' + name + '，`member` 填 ' + member + '，档案字段沿用现有记录。',
    ]
    log('info', '生成员工交接单', { name, member })
    return { name, text: lines.join('\n') }
  },
}

//21.6 导出工具：把名册与群数据落成备份文件，JSON 可回灌、Markdown 可直接读
const exportTool = {
  name: 'staff_export',
  description: '导出员工制全部数据：JSON 备份（可回灌）或 Markdown 报告（可阅读）。',
  parameters: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['json', 'markdown'], description: '导出格式，默认 json' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { path: { type: 'string' }, bytes: { type: 'number' }, message: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : '导出完成' }]
    },
  },
  async execute(args) {
    //21.6.1 format 只认 json / markdown；非法值显式报错，不静默回落成 json 备份（D-10）
    const requested = args && typeof args.format === 'string' ? args.format.trim().toLowerCase() : ''
    if (requested !== '' && requested !== 'json' && requested !== 'markdown') {
      throw new Error(`导出格式只支持 json / markdown，收到「${args.format}」`)
    }
    const format = requested === 'markdown' ? 'markdown' : 'json'
    const roster = await readRoster()
    const stores = await readGroups()
    //21.6.0 导出前先看健康度：库损坏或从备份恢复时显式告警，避免把可疑/兜底数据当成完整备份（P0-2）
    const health = storeHealth()
    const suspicious = []
    for (const [storeName, item] of Object.entries(health)) {
      if (item.health === 'corrupt') {
        suspicious.push(`${storeName}：损坏，当前为兜底空数据（证据副本 ${latestCorruptCopy(STORES[storeName].file) ?? '未找到'}）`)
      } else if (item.health === 'restored') {
        suspicious.push(`${storeName}：损坏后已从 .bak 恢复，最近一次写入可能丢失`)
      }
    }
    const warningText = suspicious.length === 0
      ? ''
      : '⚠ 数据可疑，备份可能不完整：\n' + suspicious.map((item) => '- ' + item).join('\n') + '\n\n'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(DATA_DIR, 'exports')
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, `staff-${stamp}.${format === 'json' ? 'json' : 'md'}`)
    //21.6.1 JSON 导出带导出时间与版本，便于日后回灌时判断兼容性
    let content
    if (format === 'json') {
      content = JSON.stringify({ exportedAt: new Date().toISOString(), bundle: 'dsh-staff', roster, groups: stores }, null, 2)
    } else {
      const lines = ['# 员工制导出报告', `导出时间：${new Date().toISOString()}`, '']
      lines.push('## 员工', '| 姓名 | 岗位 | 状态 | 工位 | 任务数 |', '| --- | --- | --- | --- | --- |')
      for (const [name, record] of Object.entries(roster.employees)) {
        lines.push(`| ${name} | ${record.post ?? ''} | ${record.status ?? 'active'} | ${record.member ?? '未绑定'} | ${(record.todos ?? []).length} |`)
      }
      lines.push('', '## 群')
      for (const group of Object.values(stores.groups)) {
        lines.push(`### ${group.name}`, `成员：${(group.members ?? []).join('、')}`, `消息数：${(group.messages ?? []).length}`, '')
        for (const item of group.messages ?? []) {
          lines.push(`- #${item.seq} ${item.from}: ${item.text}`)
        }
        lines.push('')
      }
      content = lines.join('\n')
    }
    await fs.writeFile(target, content, 'utf8')
    const bytes = Buffer.byteLength(content, 'utf8')
    log('info', '数据导出', { format, path: target, bytes })
    return { path: target, bytes, message: warningText + `已导出 ${format} 到：\n${target}\n大小 ${bytes} 字节` }
  },
}

//21.7.0 员工回复工具：员工把回复写进聊天界面，而不是只发给 Lead
//        这是「员工说的话能在气泡里看到」的唯一可靠通道——发送方自己写入，不依赖格式解析
const replyTool = {
  name: 'staff_reply',
  description: '把你的回复写入聊天界面（私聊或群），老板在员工中心能直接看到。只写你自己的回答，禁止复述老板原话或把别人的话改写后署自己的名。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '你的回复内容' },
      groupId: { type: 'string', description: '可选：群 ID；不传则写入你与老板的私聊' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, where: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.where ? '已写入：' + value.where : '已写入' }]
    },
  },
  async execute(args, exec) {
    const text = requireText(args, 'text', '回复内容')
    const groupId = args && typeof args.groupId === 'string' ? args.groupId.trim() : ''
    //21.7.0.1 身份取自 Agent Teams 成员名，再映射到名册里的中文员工名
    const teams = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('agentTeams') : undefined
    let memberName = null
    if (teams && typeof teams.membership === 'function' && exec && exec.agent) {
      try { memberName = teams.membership(exec.agent).name } catch (error) { memberName = null }
    }
    if (!memberName) throw new Error('无法确定当前身份，staff_reply 只能由已入册员工调用')
    const roster = await readRoster()
    const entry = Object.entries(roster.employees).find(([, record]) => record.member === memberName)
    if (!entry) throw new Error(`当前身份「${memberName}」不在名册中`)
    const employeeName = entry[0]
    const now = new Date().toISOString()
    if (groupId !== '') {
      //21.7.0.2 群回复同样锁内认领并套单群上限：与 group_send 保持一致的 500 条 + trimmedAt（A-11）
      let claimed = null
      await groupsStore.mutate((store) => {
        if (!store.groups || typeof store.groups !== 'object') store.groups = {}
        const target = store.groups[groupId]
        if (!target) throw new Error(`群 ${groupId} 不存在`)
        if (!Array.isArray(target.messages)) target.messages = []
        target.seq = (target.seq ?? 0) + 1
        target.messages.push({ seq: target.seq, from: memberName, text, mention: null, ts: now, dayKey: currentDayKey() })
        if (target.messages.length > GROUP_MESSAGE_LIMIT) {
          target.messages = target.messages.slice(-GROUP_MESSAGE_LIMIT)
          target.trimmedAt = new Date().toISOString()
        }
        claimed = { name: target.name, seq: target.seq }
      })
      log('info', '员工群内回复', { employee: employeeName, groupId, seq: claimed.seq })
      return { ok: true, where: `群「${claimed.name}」#${claimed.seq}` }
    }
    const dms = await readDms()
    const conversation = dms.conversations[employeeName] || { seq: 0, messages: [] }
    conversation.seq = (conversation.seq || 0) + 1
    conversation.messages.push({ seq: conversation.seq, from: memberName, text, ts: now })
    conversation.messages = conversation.messages.slice(-200)
    dms.conversations[employeeName] = conversation
    await writeDms(dms)
    log('info', '员工私聊回复', { employee: employeeName, seq: conversation.seq })
    return { ok: true, where: `私聊「${employeeName}」#${conversation.seq}` }
  },
}

//21.7 自检工具：把「数据看起来不对」变成可执行的检查项，出问题能自己发现
const doctorTool = {
  name: 'staff_doctor',
  description: '数据自检（分级）：problems=存储损坏/孤儿任务/序号重复倒序等必须修的问题；warnings=从备份恢复、离职成员、序号断档等提醒；infos=未绑定等现场信息。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      //21.7.0.2 输出契约：problems 只数错误（不通过判定），warnings/infos 是分级明细，便于调用方自行决定展示口径
      properties: { problems: { type: 'number' }, warnings: { type: 'number' }, infos: { type: 'number' }, text: { type: 'string' } },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.text ? value.text : '自检完成' }]
    },
  },
  async execute(args, exec) {
    //21.7.0.1 分级口径：problems=必须修的错误（数据不可用/结构损坏）；warnings=可继续使用的提醒；infos=现场信息
    //         只有 problems 非空才算「不通过」，避免一条断号提醒把健康数据判成红灯
    const problems = []
    const warnings = []
    const infos = []
    const roster = await readRoster()
    const stores = await readGroups()
    //21.7.0 存储健康度：doctor 是放行前最后一道闸，库损坏却报「自检通过」是最危险的假绿（P0-2）
    //       先触发 dms 读取，再汇总四库 health，保证读到的是本次执行的真实结果
    await readDms()
    const health = storeHealth()
    for (const [storeName, item] of Object.entries(health)) {
      if (item.health === 'corrupt') {
        const copyPath = latestCorruptCopy(STORES[storeName].file) ?? '未找到'
        problems.push(`[error] 存储「${storeName}」损坏且无可用备份：${STORES[storeName].file}（坏文件副本：${copyPath}，写操作已被拒绝）`)
      } else if (item.health === 'restored') {
        warnings.push(`[warn] 存储「${storeName}」损坏后已从备份恢复：${STORES[storeName].file}，最近一次写入可能丢失`)
      }
    }
    //21.7.1 任务层：进行中却没有派发时间、完成却没有完成时间，都说明状态被手工改过或写入中断
    for (const [name, record] of Object.entries(roster.employees)) {
      if (record.todos !== undefined && !Array.isArray(record.todos)) {
        problems.push(`[error] 员工「${name}」的 todos 不是数组，任务账本结构已损坏`)
      }
      const seenIds = new Set()
      for (const item of Array.isArray(record.todos) ? record.todos : []) {
        if (item.status === 'doing' && !item.dispatchedAt) {
          warnings.push(`[warn] 员工「${name}」任务 ${item.id}：进行中但无派发记录`)
        }
        if (item.status === 'done' && !item.doneAt) {
          warnings.push(`[warn] 员工「${name}」任务 ${item.id}：已完成但无完成时间`)
        }
        if (!item.id || !item.text) {
          problems.push(`[error] 员工「${name}」存在缺 id 或 text 的坏任务记录`)
        }
        //21.7.1.1 同一员工名下任务号重复会让 task_update 命中错行，属孤儿账本
        if (item.id && seenIds.has(item.id)) {
          problems.push(`[error] 员工「${name}」任务号重复：${item.id}`)
        }
        if (item.id) seenIds.add(item.id)
      }
      if (record.status === 'active' && !record.member) {
        infos.push(`[info] 员工「${name}」未绑定 teammate，无法投递派活`)
      }
    }
    //21.7.2 群层：成员必须在册且在职，消息序号必须从 1 连续递增
    for (const group of Object.values(stores.groups)) {
      for (const member of group.members ?? []) {
        if (!roster.employees[member]) problems.push(`[error] 群「${group.name}」成员「${member}」不在名册`)
        else if ((roster.employees[member].status ?? 'active') !== 'active') warnings.push(`[warn] 群「${group.name}」成员「${member}」已离职`)
      }
      const seqs = (group.messages ?? []).map((item) => item.seq)
      //21.7.2.1 触发过分批裁剪（trimmedAt）的群，首条 seq 必然不是 1，此时只校验相邻序号连续
      const trimmed = Boolean(group.trimmedAt)
      const shown = seqs.slice(0, 20).join(',') + (seqs.length > 20 ? '…' : '')
      //21.7.2.2 分级：序号重复/倒序才是结构破坏（前端未读位点与排序会算错）→ error；
      //         只是断档（历史删除、迁移、裁剪没打标记）消息仍可正常读写 → warn，不再冒充损坏
      const nonIncreasing = seqs.some((seq, index) => index > 0 && Number(seq) <= Number(seqs[index - 1]))
      const gapped = seqs.some((seq, index) => index > 0 && Number(seq) !== Number(seqs[index - 1]) + 1)
      const startBroken = !trimmed && seqs.length > 0 && Number(seqs[0]) !== 1
      if (nonIncreasing) {
        problems.push(`[error] 群「${group.name}」消息序号重复或倒序：${shown}（前端未读与排序会算错）`)
      } else if (gapped) {
        warnings.push(`[warn] 群「${group.name}」消息序号有断档：${shown}（历史删除或迁移造成，不影响读写）`)
      } else if (startBroken) {
        warnings.push(`[warn] 群「${group.name}」首条消息序号不是 1：${shown}（历史迁移，不影响读写）`)
      }
    }
    //21.7.3 团队层：绑定的 teammate 若不在当前 Team，跨会话时属正常，提示而非报错
    if (hostCtx && typeof hostCtx.get === 'function' && exec && exec.agent) {
      const teams = hostCtx.get('agentTeams')
      if (teams && typeof teams.listMembers === 'function') {
        try {
          const live = new Set(teams.listMembers(exec.agent).map((item) => item.name))
          for (const [name, record] of Object.entries(roster.employees)) {
            if (record.member && !live.has(record.member)) {
              infos.push(`[info] 员工「${name}」绑定的 teammate「${record.member}」不在当前会话 Team（可用 staff_rebuild 重建）`)
            }
          }
        } catch (error) {
          infos.push(`[info] teammate 绑定检查跳过：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    log('info', '数据自检', { problems: problems.length, warnings: warnings.length, infos: infos.length })
    //21.7.3 文案分层：错误在前（必须修），提醒与信息附后但不改变「通过/不通过」结论
    const toLine = (item) => `- ${item}`
    const sections = []
    if (problems.length > 0) sections.push(`发现 ${problems.length} 项问题（必须处理）：\n` + problems.map(toLine).join('\n'))
    if (warnings.length > 0) sections.push(`另有 ${warnings.length} 项提醒（可继续使用）：\n` + warnings.map(toLine).join('\n'))
    if (infos.length > 0) sections.push(`现场信息 ${infos.length} 条：\n` + infos.map(toLine).join('\n'))
    const text = problems.length === 0
      ? ['自检通过：没有发现数据损坏。', ...sections].join('\n')
      : sections.join('\n')
    return { problems: problems.length, warnings: warnings.length, infos: infos.length, text }
  },
}

//21.8 写锁包装：把工具的 execute 包进串行队列，消除并发读改写造成的覆盖
function withLock(tool) {
  const original = tool.execute
  return {
    ...tool,
    execute(args, exec) {
      return serialize(() => original(args, exec))
    },
  }
}

//21.9 工具清单用函数惰性构造：避免数组在模块顶层提前求值时引用尚未初始化的工具定义
function buildTools() {
  return [
  withLock(hireTool),
  withLock(listTool),
  withLock(showTool),
  withLock(assignTool),
  withLock(taskUpdateTool),
  withLock(fireTool),
  withLock(groupCreateTool),
  withLock(groupUpdateTool),
  withLock(groupDeleteTool),
  withLock(groupSendTool),
  withLock(groupReadTool),
  withLock(groupListTool),
  withLock(dispatchTool),
  withLock(dashboardTool),
  withLock(rebuildTool),
  withLock(exportTool),
  withLock(doctorTool),
  withLock(replyTool),
  withLock(autopilotTool),
  ]
}

//22.0 本机 HTTP 接口准入校验：这些路由不参与 DSH 认证链，必须自己把住四道关口——
//      来源地址、Host 白名单、Origin 同源、Sec-Fetch-Site；写路由再加 Content-Type。
//      历史问题：只判 remoteAddress，导致本机任意网页（含恶意站点发起的跨站请求）都能直接写名册。
//22.0.1 只允许本机来源：::ffff:127.0.0.1 是 IPv4 映射地址，同样视为本机
function isLocalRemote(req) {
  const remote = (req && req.socket && req.socket.remoteAddress) || ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

//22.0.2 读请求头：Node 会把头名转小写，这里同时兜住自测注入的假 req（头名可能是原样大小写）
function readHeader(req, name) {
  const headers = (req && req.headers) || {}
  if (typeof headers[name] === 'string') return headers[name]
  const lower = String(name).toLowerCase()
  if (typeof headers[lower] === 'string') return headers[lower]
  return ''
}

//22.0.3 拆 Host 为「主机 + 端口」：Host 允许带端口；IPv6 字面量形如 [::1]:8080
function splitHostPort(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return { host: '', port: '' }
  if (text.startsWith('[')) {
    const matched = text.match(/^\[([^\]]+)\](?::(\d+))?$/)
    return matched ? { host: '[' + matched[1] + ']', port: matched[2] || '' } : { host: text, port: '' }
  }
  const colon = text.lastIndexOf(':')
  if (colon > -1 && text.indexOf(':') === colon) {
    return { host: text.slice(0, colon), port: text.slice(colon + 1) }
  }
  return { host: text, port: '' }
}

//22.0.4 Host 必须是本机别名：防 DNS rebinding——攻击者域名解析到 127.0.0.1 后，来源地址也会是本机
//       只放行 127.0.0.1 / localhost / [::1]，端口不限（DSH Web 端口每次可能不同）
function isAllowedHostHeader(hostHeader) {
  const host = splitHostPort(hostHeader).host
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

//22.0.5 Origin 若存在必须与 Host 同源：协议只认 http/https，主机与端口都要一致；
//       Origin: null（沙箱 iframe、重定向来源）一律拒绝
function isSameOriginHeader(origin, hostHeader) {
  const text = String(origin || '').trim()
  if (!text) return true
  if (text.toLowerCase() === 'null') return false
  let parsed
  try { parsed = new URL(text) } catch (error) { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const fromOrigin = splitHostPort(parsed.host)
  const fromRequest = splitHostPort(hostHeader)
  if (!fromOrigin.host || !fromRequest.host) return false
  return fromOrigin.host === fromRequest.host && fromOrigin.port === fromRequest.port
}

//22.0.6 Sec-Fetch-Site 若存在只认 same-origin / none：现代浏览器跨站请求会带该头，是最省事的一道闸
function isAllowedFetchSite(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return true
  return text === 'same-origin' || text === 'none'
}

//22.0.7 写路由的 Content-Type 必须是 application/json（允许 ; charset 等参数）：
//       text/plain 属于 CORS 简单请求，不触发预检，浏览器无法替我们拦，只能在这里拒绝
function isJsonContentType(value) {
  const text = String(value || '').trim().toLowerCase()
  return text === 'application/json' || text.startsWith('application/json;')
}

//22.0.8 统一准入：返回 {ok:true} 或 {ok:false,status,code,error}
//       顺序固定——来源地址→Host→Origin→Sec-Fetch-Site，先判最便宜的连接层事实
function checkLocalRequest(req) {
  if (!isLocalRemote(req)) {
    return { ok: false, status: 403, code: 'FORBIDDEN_REMOTE', error: 'forbidden: 只允许本机访问' }
  }
  const host = readHeader(req, 'host')
  if (!isAllowedHostHeader(host)) {
    return { ok: false, status: 403, code: 'FORBIDDEN_HOST', error: 'forbidden: Host 不在本机白名单' }
  }
  const origin = readHeader(req, 'origin')
  if (!isSameOriginHeader(origin, host)) {
    return { ok: false, status: 403, code: 'FORBIDDEN_ORIGIN', error: 'forbidden: Origin 非同源' }
  }
  const fetchSite = readHeader(req, 'sec-fetch-site')
  if (!isAllowedFetchSite(fetchSite)) {
    return { ok: false, status: 403, code: 'FORBIDDEN_FETCH_SITE', error: 'forbidden: Sec-Fetch-Site 不允许' }
  }
  return { ok: true }
}

//22.0.9 统一错误响应：固定 {ok:false,error,code}，不回显堆栈；校验类 400、鉴权 403/415、内部 500
function sendJsonError(res, status, code, error) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error, code }))
}

//22.0.10 准入失败直接回 403，并留一条中文审计日志（只看得到来源与头，不落请求体）
function sendGuardError(res, guard, req) {
  const socket = (req && req.socket) || {}
  log('warn', 'HTTP 请求被拒绝', {
    status: guard.status || 403,
    code: guard.code || 'FORBIDDEN',
    remote: socket.remoteAddress || '',
    host: readHeader(req, 'host'),
    origin: readHeader(req, 'origin'),
    fetchSite: readHeader(req, 'sec-fetch-site'),
    url: String((req && req.url) || ''),
  })
  sendJsonError(res, guard.status || 403, guard.code || 'FORBIDDEN', guard.error || 'forbidden')
}

//22.0.11 动作路由异常分类：工具抛的中文校验错误保持 400（前端要展示原文），
//        系统级错误（fs/锁/未知异常）回 500 且只给通用文案，堆栈只进 Host 日志
const SYSTEM_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENOSPC', 'STAFF_LOCK_TIMEOUT'])
function classifyActionError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error && typeof error.code === 'string') ? error.code : ''
  const isSystem = !(error instanceof Error) || SYSTEM_ERROR_CODES.has(code) || (error && error.name === 'TypeError')
  if (isSystem) return { status: 500, code: code || 'INTERNAL_ERROR', error: '服务内部错误，详见 Host 日志' }
  return { status: 400, code: code || 'ACTION_FAILED', error: message }
}

//22.0.12 HTTP 访问令牌：进程级内存态，不落盘、不进 roster.json。
//        威胁模型要说清楚——它真实关掉的是「浏览器跨站页面」这条面（自定义头会触发 CORS 预检，
//        跨站页面既发不出也读不到响应体），挡不住「同用户本机进程」（那样的进程也能 GET client-ping）。
//        off：不生成不校验，行为与加 token 之前完全一致；warn：生成并下发，校验失败只记日志；
//        enforce：缺失/无效直接 401。默认 warn，一个环境变量即可回滚。
const TOKEN_MODES = new Set(['off', 'warn', 'enforce'])
const TOKEN_HEADER = 'x-staff-token'
function tokenModeFromEnv() {
  const raw = String(process.env.DSH_STAFF_TOKEN_MODE || '').trim().toLowerCase()
  return TOKEN_MODES.has(raw) ? raw : 'warn'
}
const httpAuth = { token: '', createdAt: 0, mode: tokenModeFromEnv(), issued: 0, rejected: 0 }
//22.0.12.1 首次需要时生成，进程内唯一；重启即换新 token，旧的自然失效
function ensureHttpToken() {
  if (!httpAuth.token) {
    httpAuth.token = randomBytes(32).toString('hex')
    httpAuth.createdAt = Date.now()
    httpAuth.issued += 1
    log('info', 'HTTP 令牌已生成', { mode: httpAuth.mode, issued: httpAuth.issued })
  }
  return httpAuth.token
}
//22.0.12.2 定长比较走 timingSafeEqual，长度不同直接 false（避免抛 RangeError）
function tokenEquals(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false
  if (!given || given.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  } catch (error) {
    return false
  }
}
//22.0.12.3 三态判定：返回 {ok:true} 或 {ok:false,status:401,code,error}。
//         warn 模式下失败分支返回 {ok:true,warn:true}，让调用方放行但留下审计日志
function checkTokenGuard(req, routeLabel) {
  if (httpAuth.mode === 'off') return { ok: true }
  const token = ensureHttpToken()
  const given = readHeader(req, TOKEN_HEADER)
  const passed = tokenEquals(given, token)
  if (passed) return { ok: true }
  httpAuth.rejected += 1
  const missing = !given
  const result = missing
    ? { status: 401, code: 'UNAUTHORIZED', error: '缺少访问令牌' }
    : { status: 401, code: 'UNAUTHORIZED', error: '访问令牌无效' }
  log('warn', 'HTTP 令牌校验失败', {
    mode: httpAuth.mode,
    route: routeLabel,
    hasToken: !missing,
    code: result.code,
  })
  if (httpAuth.mode === 'warn') return { ok: true, warn: true }
  return { ok: false, status: result.status, code: result.code, error: result.error }
}

//22.7.0 归属校验：token 只证明「请求来自能读本机 HTTP 的进程」，不证明「我在会话 X」。
//        本段补三层：会话票据（绑定 sessionId、10 分钟 TTL）+ 动作级归属（L0/L1/L2/L3）+ 破坏性动作二次确认。
//        对同用户本机进程不是硬边界（它同样能 GET client-ping 换票），价值在于把「隐式、可缺省、可覆盖的 sessionId」
//        变成「显式、有 TTL、与请求体强一致、可审计」——误投、误删、跨窗口串号都会变成显式失败。
//        三态与令牌一致：off 完全等价于改造前；warn 只记日志放行；enforce 才拒绝。一个环境变量即可回滚。
const OWNERSHIP_MODES = new Set(['off', 'warn', 'enforce'])
function ownershipModeFromEnv() {
  const raw = String(process.env.DSH_STAFF_OWNERSHIP_MODE || '').trim().toLowerCase()
  return OWNERSHIP_MODES.has(raw) ? raw : 'warn'
}
const TICKET_HEADER = 'x-staff-session-ticket'
const CONFIRM_HEADER = 'x-staff-confirm'
//22.7.0.0 TTL 允许环境变量覆盖（验收/压测需要把 10 分钟压到几十秒才能测过期分支，硬编码会让「过期」永远测不到）
function ttlFromEnv(name, fallback) {
  const raw = parseInt(String(process.env[name] || '').trim(), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
const SESSION_TICKET_TTL_MS = ttlFromEnv('DSH_STAFF_TICKET_TTL_MS', 10 * 60 * 1000)
const CONFIRM_TTL_MS = ttlFromEnv('DSH_STAFF_CONFIRM_TTL_MS', 120 * 1000)
const TICKET_SWEEP_LIMIT = 2000
const ownership = { mode: ownershipModeFromEnv(), ticketsIssued: 0, ticketsRejected: 0, denied: 0, confirmsIssued: 0, confirmsRejected: 0 }
const sessionTickets = new Map()
const confirmChallenges = new Map()

//22.7.0.1 票据与挑战码都是进程级内存态，不落盘：重启即全失效，且不可能被外部文件读取
//22.7.0.1.1 两层清理：先删过期的；仍超上限就按插入顺序删最旧（Map 保序），
//          否则「只造票不删票」能把内存顶到几十万条（qa P2-3）
function trimTicketMap(map, limit, now) {
  if (map.size <= limit) return
  for (const [key, item] of map) {
    if (!item || item.exp <= now) map.delete(key)
  }
  if (map.size <= limit) return
  let extra = map.size - limit
  for (const key of map.keys()) {
    if (extra <= 0) break
    map.delete(key)
    extra -= 1
  }
}
function sweepTicketMaps(now) {
  trimTicketMap(sessionTickets, TICKET_SWEEP_LIMIT, now)
  trimTicketMap(confirmChallenges, TICKET_SWEEP_LIMIT, now)
}
function mintSessionTicket(sid) {
  const now = Date.now()
  sweepTicketMaps(now)
  const ticket = randomBytes(16).toString('hex')
  sessionTickets.set(ticket, { sid: String(sid), exp: now + SESSION_TICKET_TTL_MS, used: false })
  ownership.ticketsIssued += 1
  return { ticket, expiresAt: new Date(now + SESSION_TICKET_TTL_MS).toISOString() }
}
//22.7.0.2 票据读取：缺票、过期、不存在三种情况分开报，前端才能给出「刷新页面」这类可操作提示
function readSessionTicket(req) {
  const raw = String(readHeader(req, TICKET_HEADER) || '').trim()
  if (raw === '') return { ok: false, code: 'SESSION_TICKET_REQUIRED', error: '缺少会话票据，请刷新页面' }
  const item = sessionTickets.get(raw)
  if (!item) return { ok: false, code: 'SESSION_TICKET_INVALID', error: '会话票据无效' }
  if (item.exp <= Date.now()) {
    sessionTickets.delete(raw)
    return { ok: false, code: 'SESSION_TICKET_EXPIRED', error: '会话票据已过期，请刷新页面' }
  }
  return { ok: true, sid: item.sid, ticket: raw }
}
//22.7.0.3 取查询参数：ping 与 confirm 都用 query 传值，避免新增自定义头再触发一次预检
function readQueryParam(req, name) {
  const url = String((req && req.url) || '')
  const index = url.indexOf('?')
  if (index < 0) return ''
  for (const pair of url.slice(index + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    let key = pair.slice(0, eq)
    let value = pair.slice(eq + 1)
    try { key = decodeURIComponent(key); value = decodeURIComponent(value) } catch (error) { continue }
    if (key === name) return String(value).trim()
  }
  return ''
}
//22.7.0.4 参数是否存在：readQueryParam 把「没这个参数」和「参数值为空」都返回 ''，
//          而 confirm 的 fields 必须区分两者——fields= 空串是「客户端声明了却没给出字段」（保守要确认），
//          fields=- 才是明确「这次没有危险字段」。另外不能用 url.indexOf('fields=') 判存在：
//          那会把 xfields= / notfields= 当成有参数（qa P3-10 实测）
function hasQueryParam(req, name) {
  const url = String((req && req.url) || '')
  const index = url.indexOf('?')
  if (index < 0) return false
  for (const pair of url.slice(index + 1).split('&')) {
    const eq = pair.indexOf('=')
    const rawKey = eq < 0 ? pair : pair.slice(0, eq)
    let key = rawKey
    try { key = decodeURIComponent(rawKey) } catch (error) { continue }
    if (key === name) return true
  }
  return false
}
//22.7.0.5 危险字段清单：只有 group-update 的 workspace/secretary 会改变「是否需要二次确认」，
//          其余破坏性动作的危险性由动作本身决定，目标已写进挑战码的 key 里
const DANGER_PAYLOAD_FIELDS = ['workspace', 'secretary']
function dangerFieldsOfPayload(action, payload) {
  if (action !== 'group-update' || !payload) return []
  const hit = []
  for (const field of DANGER_PAYLOAD_FIELDS) {
    if (payload[field] !== undefined) hit.push(field)
  }
  return hit
}

//22.7.1 请求主体：只认票据里的 sessionId；body.sessionId 只是「声明值」，不能当身份
async function resolvePrincipal(ctx, ticketSid, bodySid) {
  const agentsSvc = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const teams = ctx && typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
  const sid = typeof ticketSid === 'string' && ticketSid !== '' ? ticketSid : null
  let agent = null
  if (agentsSvc && sid && typeof agentsSvc.get === 'function') {
    try { agent = agentsSvc.get(sid) || null } catch (error) { agent = null }
  }
  let roots = []
  if (agentsSvc && typeof agentsSvc.roots === 'function') {
    try { roots = agentsSvc.roots().map((item) => item && item.id).filter(Boolean) } catch (error) { roots = [] }
  }
  let selfName = null
  if (agent && teams && typeof teams.membership === 'function') {
    try {
      const membership = teams.membership(agent)
      selfName = membership && membership.name ? String(membership.name) : null
    } catch (error) { selfName = null }
  }
  //22.7.1.1 员工工位会话以 emp-/staff- 开头：它们即使出现在 roots 里也不是老板窗口，不能当管理员
  const isStaffStation = !!sid && (sid.indexOf('emp-') === 0 || sid.indexOf('staff-') === 0)
  return {
    sid,
    declaredSid: typeof bodySid === 'string' && bodySid !== '' ? bodySid : null,
    agent,
    exists: !!agent,
    isRoot: !!sid && roots.indexOf(sid) >= 0,
    isStaffStation,
    selfName,
    isAdmin: !!sid && roots.indexOf(sid) >= 0 && !isStaffStation,
  }
}

//22.7.2 动作归属表：L0 只看自己 / L1 本人 / L2 群成员 / L3 管理员（矩阵见 design/ownership-plan.md §1.2）
//        未登记的动作按 L3 处理（fail-closed）：新增动作忘了登记，默认只给管理员
const ACTION_OWNERSHIP = {
  whoami: 'L0',
  'kb-archive': 'L1',
  'group-send': 'L2',
  wake: 'L3',
  hire: 'L3',
  'group-create': 'L3',
  'group-delete': 'L3',
  'group-kick': 'L3',
  'group-update': 'L3',
  'staff-bind-session': 'L3',
  'staff-fire': 'L3',
  dm: 'L3',
  'probe-create-staff-session': 'L3',
}
function ownershipLevelOf(action, payload) {
  //22.7.2.1 history 分两种：群历史看群成员身份（L2），私聊历史只看本人（L1）
  if (action === 'history') {
    const kind = payload && payload.kind
    return kind === 'group' ? 'L2' : 'L1'
  }
  return ACTION_OWNERSHIP[action] || 'L3'
}
async function ownershipDecision(principal, action, payload) {
  const level = ownershipLevelOf(action, payload)
  const deny = (reason, code) => ({ ok: false, level, reason, code: code || 'FORBIDDEN_OWNERSHIP' })
  if (level === 'L0') return { ok: true, level }
  //22.7.2.2 探针动作先看调试开关：没开 DSH_STAFF_DEBUG=1 时连管理员也不放行，避免线上误用
  if (action === 'probe-create-staff-session' && String(process.env.DSH_STAFF_DEBUG || '') !== '1') {
    return deny('调试动作未启用', 'FORBIDDEN_DEBUG_ACTION')
  }
  if (principal.isAdmin) return { ok: true, level }
  if (level === 'L3') return deny(action + ' 只允许老板窗口（当前会话不是管理员会话）')
  if (!principal.selfName) return deny(action + ' 需要员工身份，当前会话未绑定员工')
  if (level === 'L1') {
    const employee = payload && typeof payload.employee === 'string' ? payload.employee : ''
    if (employee === '') return deny(action + ' 缺少员工姓名')
    if (employee !== principal.selfName) return deny(action + ' 只能操作自己的数据')
    return { ok: true, level }
  }
  const groupId = payload && typeof (payload.id || payload.groupId) === 'string' ? (payload.id || payload.groupId) : ''
  if (groupId === '') return deny(action + ' 缺少群 ID')
  const groups = await readGroups()
  const group = groups.groups ? groups.groups[groupId] : undefined
  if (!group) return deny(action + ' 的群 ' + groupId + ' 不存在')
  const members = Array.isArray(group.members) ? group.members : []
  if (members.indexOf(principal.selfName) < 0) return deny(action + ' 只允许群成员执行')
  return { ok: true, level }
}

//22.7.3 二次确认：破坏性动作必须先在 GET /staff-api/confirm 换一张挑战码，动作请求带 x-staff-confirm。
//        同机进程能自己换码再立刻用掉——它是「防误点/防跨站驱动/留审计」的防线，不是对抗本机进程的鉴权，文档已写明。
const CONFIRM_ACTIONS = new Set(['staff-fire', 'group-delete', 'group-kick', 'staff-bind-session', 'kb-archive'])
function needsConfirm(action, payload) {
  if (CONFIRM_ACTIONS.has(action)) return true
  //22.7.3.1 群设置只有改工作区或改秘书才需要确认：改个名字不值得打断老板
  if (action === 'group-update') {
    return !!payload && (payload.workspace !== undefined || payload.secretary !== undefined)
  }
  return false
}
function confirmTargetOf(action, payload) {
  if (!payload) return ''
  if (typeof payload.groupId === 'string' && payload.groupId !== '') return payload.groupId
  if (typeof payload.id === 'string' && payload.id !== '') return payload.id
  if (typeof payload.name === 'string' && payload.name !== '') return payload.name
  if (typeof payload.employee === 'string' && payload.employee !== '') return payload.employee
  if (typeof payload.member === 'string' && payload.member !== '') return payload.member
  return ''
}
//22.7.3.5 declaredFields 把「老板确认的是什么」记进挑战码：null=客户端没声明（老客户端，按宽松兼容）；
//          []=明确声明没有危险字段；['workspace']=声明只改工作区。执行时再拿真实载荷回比，
//          防止「弹框问的是改秘书、实际执行改工作区」（qa P3-9 实测 200 通过）
function mintConfirmChallenge(sid, action, target, declaredFields) {
  const now = Date.now()
  sweepTicketMaps(now)
  const key = String(sid) + '|' + action + '|' + target
  const challenge = randomBytes(16).toString('hex')
  confirmChallenges.set(key, { challenge, exp: now + CONFIRM_TTL_MS, used: false, fields: declaredFields })
  ownership.confirmsIssued += 1
  return { challenge, action, target, expiresAt: new Date(now + CONFIRM_TTL_MS).toISOString() }
}
function checkConfirm(principal, action, payload, req) {
  const target = confirmTargetOf(action, payload)
  const key = String(principal.sid) + '|' + action + '|' + target
  const item = confirmChallenges.get(key)
  const given = String(readHeader(req, CONFIRM_HEADER) || '').trim()
  //22.7.3.3 语义区分：没带码 = 还没确认（428，前端去取码）；带了码却没有对应挑战（跨动作/跨目标/过期被清）=
  //          这张码无效（403 CONFIRM_INVALID），否则客户端会误以为「确认没生效」而反复取码
  if (!item) {
    if (given !== '') return { ok: false, status: 403, code: 'CONFIRM_INVALID', error: '确认凭据无效，请重新确认' }
    return { ok: false, status: 428, code: 'CONFIRM_REQUIRED', error: '该动作需要二次确认：请刷新页面后重试' }
  }
  if (item.exp <= Date.now()) {
    confirmChallenges.delete(key)
    return { ok: false, status: 428, code: 'CONFIRM_REQUIRED', error: '该动作需要二次确认：请刷新页面后重试' }
  }
  //22.7.3.4 没带码 = 还没确认（428，前端会去取码）；码不符或已被消费 = 这张码无效（403）。
  //          区分两者的原因是客户端只在 428 自动取码（client.js 取码分支），
  //          若把「已消费后再点一次」判成 403，老板重试会一直失败到 TTL 到期（qa P2-8 实测）
  if (given === '') {
    return { ok: false, status: 428, code: 'CONFIRM_REQUIRED', error: '该动作需要二次确认：请刷新页面后重试' }
  }
  if (item.used || given !== item.challenge) {
    return { ok: false, status: 403, code: 'CONFIRM_INVALID', error: '确认凭据无效，请重新确认' }
  }
  //22.7.3.6 声明与执行必须一致：老板在弹框里确认的是「改这几个字段」，执行时多改了一个就是换了内容。
  //          没声明（null）的老客户端保持宽松——否则升级前后老客户端会永久 428；
  //          不覆盖时删掉这张码并要求重新确认（428），避免同一张码被用来执行未确认的内容
  if (Array.isArray(item.fields)) {
    const actual = dangerFieldsOfPayload(action, payload)
    const uncovered = actual.filter((field) => item.fields.indexOf(field) < 0)
    if (uncovered.length > 0) {
      confirmChallenges.delete(key)
      const shownDeclared = item.fields.length > 0 ? item.fields.join('、') : '无危险字段'
      return {
        ok: false,
        status: 428,
        code: 'CONFIRM_REQUIRED',
        error: '确认内容与本次改动不一致（确认的是「' + shownDeclared + '」，本次还改了「' + uncovered.join('、') + '」），请重新确认',
      }
    }
  }
  //22.7.3.2 单次消费：同一张挑战码只能用一次，避免一次确认被批量复用
  item.used = true
  return { ok: true, target }
}

//22.7.4 归属门禁结果落地：warn 只记日志并放行（与令牌同节奏），enforce 才真正拒绝
function ownershipDeny(res, result, action, principal) {
  ownership.denied += 1
  log('warn', 'HTTP 动作归属被拒', {
    mode: ownership.mode,
    action,
    sid: principal && principal.sid,
    declaredSid: principal && principal.declaredSid,
    level: result.level || '',
    code: result.code || '',
    reason: result.reason || result.error || '',
  })
  if (ownership.mode !== 'enforce') return false
  sendJsonError(res, result.status || 403, result.code || 'FORBIDDEN_OWNERSHIP', result.error || '当前会话无权执行该动作')
  return true
}

//22.1.0a 快照窗口：messages 与 conversations 只回最近 60 条，界面上必须能说清「共 N 条、只显示最近 60 条」
const SNAPSHOT_WINDOW = 60

//22.1.0b 快照版本号：三个 store 文件的 mtimeMs+size 加条目数做 FNV-1a，
//        数据不变则 rev 稳定，前端据此跳过整树重渲染；文件缺失按 0 计，仍是稳定值
function fnv1a(input) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
function fileRevision(file, entryCount) {
  let stat = null
  try { stat = statSync(file) } catch (error) { stat = null }
  const mtime = stat ? Math.floor(stat.mtimeMs) : 0
  const size = stat ? stat.size : 0
  return mtime + ':' + size + ':' + entryCount
}
function snapshotRevision(counts) {
  const parts = [
    fileRevision(ROSTER_PATH, counts.roster),
    fileRevision(GROUP_PATH, counts.groups),
    fileRevision(DMS_PATH, counts.dms),
  ]
  return fnv1a(parts.join('|'))
}

//22.1.0c 健康度投影：store.state.health 是 read 的副产物（取值 unknown/ok/missing/corrupt/restored），
//        快照只对外暴露契约约定的四种；未读过（unknown）按缺失处理，不虚报健康
const SNAPSHOT_HEALTH_VALUES = new Set(['ok', 'missing', 'corrupt', 'restored'])
function snapshotHealth() {
  const summary = storeHealth()
  const pick = (item) => {
    const health = item && typeof item.health === 'string' ? item.health : 'unknown'
    return SNAPSHOT_HEALTH_VALUES.has(health) ? health : 'missing'
  }
  return { roster: pick(summary.roster), groups: pick(summary.groups), dms: pick(summary.dms) }
}

//22.1 HTTP 快照接口：给 Web UI 提供只读数据，绕开 Typert Remote 的复杂注册
//      快照与心跳只读；动作路由只接受本机同源的 JSON POST，避免浏览器侧绕过工具权限直接改数据
function registerHttpRoutes(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return
  //22.1.2 启动顺序：插件可能先于 webServer 激活，轮询等待就绪，最多 10 秒
  let attempts = 0
  const tryRegister = () => {
    const web = ctx.get('webServer')
    if (!web || typeof web.register !== 'function') {
      attempts += 1
      if (attempts <= 20) { setTimeout(tryRegister, 500); return }
      log('warn', 'webServer 始终不可用，跳过 HTTP 接口')
      return
    }
    ctx.effect(() => web.register({
    kind: 'exact',
    path: '/staff-api/snapshot',
    async handler(req, res) {
      try {
        //22.1.0 准入校验：来源地址 + Host + Origin + Sec-Fetch-Site，任一不过直接拒绝
        //       该路由不参与 DSH 认证链，局域网访问与恶意网页读取都靠这一层兜底
        const guard = checkLocalRequest(req)
        if (!guard.ok) {
          sendGuardError(res, guard, req)
          return
        }
        //22.1.0.1 令牌校验：warn 放行并留痕，enforce 缺失/无效即 401；快照含岗位/私聊/路径，属敏感读
        const tokenGuard = checkTokenGuard(req, 'snapshot')
        if (!tokenGuard.ok) {
          sendJsonError(res, tokenGuard.status, tokenGuard.code, tokenGuard.error)
          return
        }
        //22.1.1 只输出未完成任务与群摘要，控制响应体积
        const roster = await readRoster()
        const stores = await readGroups()
        //22.1.1.1 实时在线名单：遍历全部会话根汇总 teammate
        //        teammate 是会话内实体，只看 roots()[0] 会把「待在别的会话」的人误判成离线
        const liveNames = new Set()
        //22.1.1.2 反查每个 teammate 所在会话，详情页要能指出工位落在哪个会话
        const liveSessionByMember = new Map()
        try {
          const teams = ctx.get('agentTeams')
          const agentsSvc = ctx.get('agents')
          const roots = agentsSvc && typeof agentsSvc.roots === 'function' ? agentsSvc.roots() : []
          if (teams && typeof teams.listMembers === 'function' && roots.length > 0) {
            for (const root of roots) {
              const lead = agentsSvc && typeof agentsSvc.get === 'function' ? (agentsSvc.get(root.id) || root) : root
              if (!lead) continue
              try {
                for (const item of teams.listMembers(lead)) {
                  if (!item || !item.name) continue
                  liveNames.add(item.name)
                  //22.1.1.2 会话 id 优先取根本身，根对象缺 id 时退回 lead，避免 online 却没有落点
                  //22.1.1.2.1 只写非空：先扫到无 id 的会话不能把 null 写死，否则后到的好会话永远覆盖不上（会把活人判成 missing）
                  if (!liveSessionByMember.get(item.name)) {
                    const candidate = root.id ?? lead.id ?? null
                    if (candidate) liveSessionByMember.set(item.name, candidate)
                  }
                }
              } catch (error) { /* 单个会话不可查不影响其余会话 */ }
            }
          }
        } catch (error) {
          // 在线状态取不到不影响其余数据返回
        }
        //22.1.1.3 工位三态：online=会话里确实有这个 teammate；missing=名册绑了名但所有会话都没有；unbound=没绑定
        //         区分的意义：missing 可一键重建（reviveMember），离线只是暂时，未绑定要先入职
        //22.1.1.4 工位所在会话：拿不到会话就当没有落点，不能只凭名字判在线
        const sessionOf = (record) => {
          if (!record || !record.member) return null
          return liveSessionByMember.get(record.member) ?? null
        }
        //22.1.1.5 online 必须名在会话里且有可定位会话；否则一律 missing（missing 可自愈重建）
        const stationOf = (record) => {
          if (!record || !record.member) return 'unbound'
          if (!liveNames.has(record.member)) return 'missing'
          return sessionOf(record) ? 'online' : 'missing'
        }
        const employees = Object.entries(roster.employees).map(([name, record]) => {
          const station = stationOf(record)
          const sessionId = sessionOf(record)
          return {
          name,
          post: record.post ?? '',
          //22.1.3.1 详情页需要完整岗位说明书与工位信息
          duty: record.duty ?? '',
          model: record.model ?? null,
          hiredAt: record.hiredAt ?? null,
          status: record.status ?? 'active',
          member: record.member ?? null,
          //22.1.3.1 三态工位：online/missing/unbound，前端据此分组与给「重建工位」入口
          station,
          //22.1.3.2 工位实际所在会话：missing 时为 null，前端详情页显示「无处安放，发消息会自动重建」
          stationSessionId: sessionId,
          //22.1.3.3 online 与 station 同源，避免两套口径漂移
          online: station === 'online',
          open: (record.todos ?? []).filter((item) => item.status !== 'done').map((item) => ({
            id: item.id,
            text: item.text,
            status: item.status,
            priority: item.priority ?? 'normal',
            due: item.due ?? null,
          })),
          }
        })
        //22.1.6 工作区索引：把群绑定的路径换成 workspaceId，界面才能在该工作区新开会话
        const workspaceIndex = await readWorkspaceIndex()
        //22.1.1.6 名册人名集合：群成员里可能残留已删/手改的名字，前端要能标注而不是假装是活人
        const rosterNames = new Set(Object.keys(roster.employees))
        const groups = Object.values(stores.groups).map((group) => {
          //22.1.4.0 members 可能是脏数据（手改成字符串）：这里必须自己兜底，否则一个群打挂整页快照
          const rawMembers = Array.isArray(group.members) ? group.members : []
          const allMessages = Array.isArray(group.messages) ? group.messages : []
          const today = currentDayKey()
          //22.1.4 按天分组：6 点为界统计每天的消息数与最后一条，供前端翻阅历史
          const dayMap = new Map()
          for (const item of allMessages) {
            const key = item.dayKey || dayKeyOf(item.ts) || 'unknown'
            if (!dayMap.has(key)) dayMap.set(key, { dayKey: key, count: 0, last: null, firstAt: item.ts, lastAt: item.ts })
            const bucket = dayMap.get(key)
            bucket.count += 1
            bucket.last = item.text ?? bucket.last
            bucket.lastAt = item.ts
          }
          const dayHistory = [...dayMap.values()].sort((a, b) => String(b.dayKey).localeCompare(String(a.dayKey)))
          return {
            id: group.id,
            name: group.name,
            //22.1.4.1 成员只喂名册内的人：悬空名字不能让前端当成活人渲染（与 doctor 报错同口径）
            members: rawMembers.filter((member) => rosterNames.has(member)),
            //22.1.4.2 但悬空事实不能丢：单独给一份并去重（重复名字会让「有 N 人」虚报），管理员据此修数据
            danglingMembers: [...new Set(rawMembers.filter((member) => !rosterNames.has(member)))],
            //22.1.4.3 已离职仍在群里：保留在 members（不改变群成员口径），单独列出供前端提示；群发按 active 过滤另议
            inactiveMembers: [...new Set(rawMembers.filter((member) => rosterNames.has(member) && (roster.employees[member].status ?? 'active') !== 'active'))],
            count: allMessages.length,
            last: allMessages.slice(-1)[0]?.text ?? null,
            //22.1.3 附最近 60 条供气泡渲染；count 保留总数，避免前端误判
            messages: allMessages.slice(-SNAPSHOT_WINDOW),
            //22.1.3.2 契约 §4：total 是消息总数、truncated 说明 messages 是否被窗口截断，
            //        前端据此显示「仅显示最近 60 条 · 共 N 条」
            total: allMessages.length,
            truncated: allMessages.length > SNAPSHOT_WINDOW,
            //22.1.5 工作区与按天视图
            workspace: group.workspace ?? null,
            //22.1.9 秘书：老板发言只投给她，界面需要显示当前中转人
            secretary: group.secretary ?? null,
            //22.1.7 路径匹配失败时为 null，界面据此禁用「开新会话」而不是盲目打开默认工作区
            workspaceId: group.workspace
              ? (workspaceIndex[normalizeWorkspacePath(group.workspace)] ?? null)
              : null,
            currentDay: today,
            todayCount: allMessages.filter((item) => (item.dayKey || dayKeyOf(item.ts)) === today).length,
            //22.1.8 最后一条消息所属的工作日：跨天判定看它，不能看 dayHistory[0]（那是倒序首项）
            lastDayKey: allMessages.length > 0
              ? (allMessages[allMessages.length - 1].dayKey || dayKeyOf(allMessages[allMessages.length - 1].ts) || null)
              : null,
            dayHistory,
          }
        })
        const dms = await readDms()
        const conversations = {}
        const conversationsTotal = {}
        for (const [name, conversation] of Object.entries(dms.conversations)) {
          const allDmMessages = Array.isArray(conversation.messages) ? conversation.messages : []
          conversations[name] = allDmMessages.slice(-SNAPSHOT_WINDOW)
          //22.1.3.3 契约 §4：私聊同样给总数，界面显示「仅显示最近 60 条 · 共 N 条」
          conversationsTotal[name] = allDmMessages.length
        }
        //22.1.3.4 契约 §4：health 取 read 的副产物（此处三个 store 均已读过，不会残留 unknown），
        //        rev 由文件 mtime/size/条目数汇总，数据不变则同值，前端据此跳过重渲染
        const health = snapshotHealth()
        const rev = snapshotRevision({
          roster: Object.keys(roster.employees).length,
          groups: Object.keys(stores.groups).length,
          dms: Object.keys(dms.conversations).length,
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          employees,
          groups,
          conversations,
          conversationsTotal,
          at: new Date().toISOString(),
          clientPingAt,
          clientPingSource,
          rev,
          health,
          truncationWindow: { messages: SNAPSHOT_WINDOW },
        }))
      } catch (error) {
        //22.1.10 内部错误只回通用文案，堆栈与原始 message 只进日志，避免向外泄露路径与实现细节
        log('error', 'HTTP 快照失败', { message: error instanceof Error ? error.message : String(error) })
        sendJsonError(res, 500, 'INTERNAL_ERROR', '服务内部错误，详见 Host 日志')
      }
    },
  }))
  //22.2 客户端心跳路由：前端组件挂载时调用一次，Host 侧记录时间，供无浏览器环境确认加载
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/staff-api/client-ping',
    handler(req, res) {
      //22.0.8 准入校验与快照路由一致：心跳虽只读，同样不接受跨站请求
      const guard = checkLocalRequest(req)
      if (!guard.ok) {
        sendGuardError(res, guard, req)
        return
      }
      clientPingAt = new Date().toISOString()
      //22.2.1 记录来源：from=react 才是真实组件上报，用于区分人工 curl 验证
      const url = String(req.url || '')
      clientPingSource = url.includes('from=react') ? 'react' : 'manual'
      log('info', '客户端心跳', { at: clientPingAt, source: clientPingSource })
      //22.2.2 令牌下发：页面加载先 ping 一次拿 token，随后快照与动作都带上；
      //        off 模式不下发（响应体保持三字段，老客户端字节级不变），warn/enforce 下发 32 字节 hex
      const pingBody = { ok: true, at: clientPingAt, source: clientPingSource }
      if (httpAuth.mode !== 'off') pingBody.token = ensureHttpToken()
      //22.7.7 会话票据签发：ping 带 ?sessionId=<当前会话> 时签一张 10 分钟票据。
      //        Host 侧没有「当前前台会话」的权威状态（见 design/session-attribution.md），票据绑定的是客户端声明值，
      //        作用是把「隐式可覆盖的 sessionId」变成「显式、有 TTL、与请求体强一致、可审计」的记录
      if (ownership.mode !== 'off') {
        const claimedSid = readQueryParam(req, 'sessionId')
        if (claimedSid !== '') {
          const minted = mintSessionTicket(claimedSid)
          pingBody.ticket = minted.ticket
          pingBody.ticketExpiresAt = minted.expiresAt
          pingBody.ticketSessionId = claimedSid
        }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(pingBody))
    },
  }))
  //22.2.4 动作路由：UI 的写操作入口，与工具共用实现
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/staff-api/action',
    async handler(req, res) {
      //22.0.8 写路由准入：来源、Host、Origin、Sec-Fetch-Site 全过才继续，任意一条不过都是 403
      const guard = checkLocalRequest(req)
      if (!guard.ok) {
        sendGuardError(res, guard, req)
        return
      }
      if (req.method !== 'POST') {
        sendJsonError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 POST')
        return
      }
      const contentType = readHeader(req, 'content-type')
      //22.0.7 必须是 JSON：text/plain 属于简单请求、浏览器不发预检，只能在这里拦
      if (!isJsonContentType(contentType)) {
        log('warn', 'HTTP 动作请求 Content-Type 非法', { contentType, url: String(req.url || '') })
        sendJsonError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必须是 application/json')
        return
      }
      //22.0.12.4 令牌校验放在 method/Content-Type 之后：405/415 的既有语义不变，
      //           同时仍然挡在 readBody 之前，无凭证的调用者拿不到请求体处理结果
      const tokenGuard = checkTokenGuard(req, 'action')
      if (!tokenGuard.ok) {
        sendJsonError(res, tokenGuard.status, tokenGuard.code, tokenGuard.error)
        return
      }
      //22.7.5 会话票据：token 之后的第二道。缺票/过期/无效在 enforce 下 401，warn 只记日志，
      //        off 完全不看票据（等价于改造前）。票据必须在 readBody 之前判定，无凭证者拿不到请求体处理结果
      //22.7.5.1 【顺序契约，改前先读 client.js //17.8.16】票据 401 必须发生在 readBody/归属/业务之前：
      //         浏览器端在收到票据类 401 后会「换票并重放一次」（写动作也重放），前提是这一次请求根本没被执行过。
      //         若把判定挪到 readBody 之后或业务内部，重放就会变成重复投递，必须同步把 client.js 的回放改成只放读动作。
      const ticketRead = readSessionTicket(req)
      if (!ticketRead.ok && ownership.mode !== 'off') {
        ownership.ticketsRejected += 1
        log('warn', 'HTTP 会话票据不可用', { route: 'action', mode: ownership.mode, code: ticketRead.code })
        if (ownership.mode === 'enforce') {
          sendJsonError(res, 401, ticketRead.code, ticketRead.error)
          return
        }
      }
      let raw
      try {
        raw = await readBody(req)
      } catch (error) {
        //22.0.11 读体失败（如超过 64KB）属于请求问题，按校验类 400 返回
        log('warn', 'HTTP 动作请求体读取失败', { message: error instanceof Error ? error.message : String(error) })
        sendJsonError(res, 400, 'INVALID_BODY', '请求体读取失败：' + (error instanceof Error ? error.message : String(error)))
        return
      }
      let parsed
      try {
        parsed = JSON.parse(raw || '{}')
      } catch (error) {
        //22.0.11 非法 JSON 归校验类 400，不回显解析器原文
        log('warn', 'HTTP 动作请求体不是合法 JSON', { length: String(raw || '').length })
        sendJsonError(res, 400, 'INVALID_JSON', '请求体不是合法 JSON')
        return
      }
      const action = parsed && typeof parsed.action === 'string' ? parsed.action : ''
      if (!action) {
        sendJsonError(res, 400, 'INVALID_ACTION', '缺少 action 字段')
        return
      }
      try {
        //22.7.6 归属门禁三步：票据 sid 与请求体 sid 一致性 → 动作级归属 → 破坏性动作二次确认。
        //        三步都走 ownershipDeny：warn/off 只记日志放行，enforce 才回 403/428
        const payload = (parsed && parsed.payload) || {}
        const principal = await resolvePrincipal(ctx, ticketRead.ok ? ticketRead.sid : null, parsed && parsed.sessionId)
        //22.7.6.1 L0 诊断动作（whoami）不受一致性约束：它的语义就是「我自报 X，你回真相」，
        //        若这里也 403，客户端永远拿不到 declared/claimed 的差异，排障口子自己先瞎了
        if (ownershipLevelOf(action, payload) !== 'L0' && ticketRead.ok && principal.sid && principal.declaredSid && principal.declaredSid !== principal.sid) {
          const mismatch = { status: 403, code: 'SESSION_MISMATCH', error: '请求会话与票据不一致', level: 'SID', reason: 'declared=' + principal.declaredSid + ' ticket=' + principal.sid }
          if (ownershipDeny(res, mismatch, action, principal)) return
        }
        const decision = await ownershipDecision(principal, action, payload)
        if (!decision.ok) {
          const denied = { status: 403, code: decision.code || 'FORBIDDEN_OWNERSHIP', error: '当前会话无权执行该动作', level: decision.level, reason: decision.reason }
          if (ownershipDeny(res, denied, action, principal)) return
        }
        if (needsConfirm(action, payload)) {
          const confirmed = checkConfirm(principal, action, payload, req)
          if (!confirmed.ok) {
            const blocked = { status: confirmed.status, code: confirmed.code, error: confirmed.error, level: 'CONFIRM', reason: 'target=' + confirmTargetOf(action, payload) }
            if (ownershipDeny(res, blocked, action, principal)) return
          }
        }
        const callerSid = principal.sid || principal.declaredSid
        const result = await handleAction(ctx, action, payload, callerSid, principal)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, result }))
      } catch (error) {
        //22.0.11 校验类错误保持 400 原文（前端要展示），系统级错误 500 且只给通用文案
        const classified = classifyActionError(error)
        log(classified.status >= 500 ? 'error' : 'warn', 'HTTP 动作失败', {
          action,
          status: classified.status,
          code: classified.code,
          message: error instanceof Error ? error.message : String(error),
        })
        sendJsonError(res, classified.status, classified.code, classified.error)
      }
    },
  }))
  //22.7.8 二次确认挑战码路由：破坏性动作（解雇/解散群/踢人/绑定工位/归档知识库/改群设置）
  //        先来换一张 120 秒、单次消费的挑战码，动作请求再带 x-staff-confirm。
  //        同机进程能自己换码——它是「防误点/防跨站驱动/留审计」的防线，不是对抗本机进程的鉴权
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/staff-api/confirm',
    handler(req, res) {
      const guard = checkLocalRequest(req)
      if (!guard.ok) {
        sendGuardError(res, guard, req)
        return
      }
      if (req.method !== 'GET') {
        sendJsonError(res, 405, 'METHOD_NOT_ALLOWED', '只接受 GET')
        return
      }
      const tokenGuard = checkTokenGuard(req, 'confirm')
      if (!tokenGuard.ok) {
        sendJsonError(res, tokenGuard.status, tokenGuard.code, tokenGuard.error)
        return
      }
      const sendBody = (body) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      //22.7.8.1 off 模式明确告诉前端「不用确认」，前端按 required=false 跳过弹框，流程不必分叉
      if (ownership.mode === 'off') {
        sendBody({ ok: true, required: false, disabled: true })
        return
      }
      const action = readQueryParam(req, 'action')
      const target = readQueryParam(req, 'target')
      if (action === '') {
        sendJsonError(res, 400, 'INVALID_ACTION', '缺少 action 参数')
        return
      }
      //22.7.8.2 group-update 是否需要确认取决于「这次请求有没有改 workspace/secretary」，
      //          而 confirm 路由只拿到 action+target。客户端用 fields 参数声明本次真实携带的危险字段：
      //          fields=workspace,secretary 或 fields=-（明确没有）。老客户端不传 fields 时保守按「要确认」处理，
      //          绝不允许「取码侧 required:false、执行侧 428」这种死锁（qa P1-1 实测：group-update 改工作区永久不可用）
      //22.7.8.3 fields 声明三态（qa P3-10）：参数不存在 = 老客户端/未声明 → null（保守按「要确认」）；
      //          fields=- = 明确没有危险字段 → []；其余按逗号切。fields= 空串 = 声明了却没给字段，也按 null 保守，
      //          参数存在性用 hasQueryParam 精确比对，不再用 url.indexOf('fields=') 把 xfields= 误判成声明
      const rawFields = readQueryParam(req, 'fields')
      const hasFieldsParam = hasQueryParam(req, 'fields')
      const declaredFields = !hasFieldsParam || rawFields === ''
        ? null
        : (rawFields === '-' ? [] : rawFields.split(',').map((item) => item.trim()).filter(Boolean))
      const syntheticPayload = { name: target, employee: target, groupId: target, id: target }
      if (declaredFields === null) {
        // 未声明：保守——group-update 按「可能改工作区」处理，绝不允许「取码 required:false、执行侧 428」这种死锁
        if (action === 'group-update') syntheticPayload.workspace = ''
      } else {
        for (const key of declaredFields) syntheticPayload[key] = ''
      }
      if (!needsConfirm(action, syntheticPayload)) {
        sendBody({ ok: true, required: false, action, target })
        return
      }
      const ticketRead = readSessionTicket(req)
      if (!ticketRead.ok) {
        ownership.ticketsRejected += 1
        if (ownership.mode === 'enforce') {
          sendJsonError(res, 401, ticketRead.code, ticketRead.error)
          return
        }
        sendJsonError(res, 428, 'CONFIRM_REQUIRED', '缺少会话票据，请刷新页面后重试')
        return
      }
      const minted = mintConfirmChallenge(ticketRead.sid, action, target, declaredFields)
      sendBody({ ok: true, required: true, sid: ticketRead.sid, challenge: minted.challenge, action: minted.action, target: minted.target, expiresAt: minted.expiresAt })
    },
  }))
  log('info', 'HTTP 接口已注册', '/staff-api/snapshot, /staff-api/client-ping, /staff-api/action, /staff-api/confirm')
  }
  tryRegister()
}

//22.2.0 员工上线：重启后 Team 是空的，按名册把绑定工位的员工重新 spawn 起来
function buildStaffPrompt(name, record) {
  return [
    `你是${name}，岗位：${record.post ?? ''}。`,
    '',
    '【岗位说明书】',
    record.duty ?? '',
    '',
    '【工作方式】',
    '1. 接到任务先复述理解，再动手。',
    '2. 不确定就说不确定，严禁编造数据与来源。',
    '3. 完成后用 send_message 回报 lead。',
  ].join('\n')
}

//22.2.0.3 员工历史档案：从名册任务与群发言拼出可读的近期记录，缓解「每次上线都是新人」
function buildStaffMemory(record, stores) {
  const lines = []
  //22.2.0.3a 任务落在 record.todos（staff_assign 写这个字段），旧实现读 record.tasks 恒为空，导致记忆里永远没有任务（A-09）
  const tasks = Array.isArray(record.todos) ? record.todos : []
  const taskText = (item) => String((item && (item.text || item.task)) || '').slice(0, 60)
  const done = tasks.filter((item) => item && item.status === 'done').slice(-5)
  const open = tasks.filter((item) => item && (item.status === 'todo' || item.status === 'doing')).slice(0, 5)
  if (done.length > 0) {
    lines.push('【近期已完成】')
    for (const item of done) lines.push('- ' + taskText(item))
  }
  if (open.length > 0) {
    lines.push('【当前待办】')
    for (const item of open) lines.push('- ' + taskText(item))
  }
  //22.2.0.4 群发言只取署名本人的记录，作为「你说过什么」的依据
  const member = record.member
  const said = []
  if (member && stores && stores.groups) {
    for (const group of Object.values(stores.groups)) {
      for (const message of group.messages || []) {
        if (message.from === member) said.push(String(message.text || '').slice(0, 50))
      }
    }
  }
  if (said.length > 0) {
    lines.push('【你近期在群里说过】')
    for (const item of said.slice(-3)) lines.push('- ' + item)
  }
  return lines.length > 0 ? lines.join('\n') : ''
}

async function wakeAllEmployees(ctx, callerSessionId, scope) {
  const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
  const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  //22.2.0.2 优先用 UI 传来的会话作为 Lead；多窗口时不能取进程里第一个，否则员工会挂到别的会话
  let lead
  if (agentsSvc && callerSessionId && typeof agentsSvc.get === 'function') {
    try { lead = agentsSvc.get(callerSessionId) } catch (error) { lead = undefined }
  }
  if (!lead && agentsSvc && typeof agentsSvc.roots === 'function') lead = agentsSvc.roots()[0]
  if (!teams || typeof teams.spawnTeammate !== 'function') throw new Error('Agent Teams 不可用')
  if (!lead) throw new Error('当前没有可用的 Lead 会话')
  //22.2.0.11 只把未失败的成员算作「已在线」：failed 的 agent 再唤醒一次也只会再失败一次，还会刷屏
  const live = new Set(
    teams.listMembers(lead)
      .filter((item) => item.status !== 'failed')
      .map((item) => item.name),
  )
  const roster = await readRoster()
  //22.2.0.5 群数据用于拼历史档案与解析群成员范围，读一次复用
  const stores = await readGroups()
  //22.2.0.6 上线范围：指定员工、指定群的成员，或空表示全部；按范围上线可避免每次重启叫醒所有人
  let targetNames = null
  if (scope && scope.kind === 'employee' && typeof scope.name === 'string' && scope.name !== '') {
    targetNames = new Set([scope.name])
  } else if (scope && scope.kind === 'group' && typeof scope.id === 'string' && scope.id !== '') {
    const group = stores.groups ? stores.groups[scope.id] : undefined
    if (!group) throw new Error(`群 ${scope.id} 不存在`)
    targetNames = new Set(Array.isArray(group.members) ? group.members : [])
  }
  const results = []
  for (const [name, record] of Object.entries(roster.employees)) {
    //22.2.0.7 有范围时只处理范围内的员工
    if (targetNames && !targetNames.has(name)) continue
    if ((record.status ?? 'active') !== 'active') continue
    const member = record.member
    //22.2.0.14 未绑定工位的员工也要留在结果里：state=skipped，前端按枚举计数，不再静默消失
    if (!member) { results.push({ name, ok: false, state: 'skipped', reason: '未绑定工位' }); continue }
    //22.2.0.12 每个员工用自己在 yuangong 工作区的专属会话，互相不抢名额
    const staffLead = agentsSvc ? await ensureStaffSession(agentsSvc, member) : null
    const caller = staffLead || lead
    let inCaller = live
    if (staffLead && caller !== lead) {
      try {
        inCaller = new Set(
          teams.listMembers(caller)
            .filter((item) => item.status !== 'failed')
            .map((item) => item.name),
        )
      } catch (error) {
        inCaller = new Set()
      }
    }
    if (inCaller.has(member)) {
      //22.2.0.15 已在线也带 state=already，与 online/failed/skipped 同构，前端一次枚举即可统计
      results.push({ name, ok: true, state: 'already', reason: '已在线（会话 ' + String(caller && caller.id) + '）' })
      continue
    }
    try {
      //22.2.0.1 上线口令带历史档案，让她知道自己的过去；仍只要求回一句待命，避免一上线跑长任务烧钱
      const memory = buildStaffMemory(record, stores)
      const promptText = buildStaffPrompt(name, record)
        + (memory ? '\n\n【你的工作档案（跨会话记忆）】\n' + memory : '')
        + '\n\n【当前指示】\n现在上线待命，只回一句「待命」，不要执行任何任务。'
      //22.2.0.10 上线前记录实际传入的 provider，便于排查「明明改了却还是旧的」
      log('info', '员工上线准备', { name, member, provider: TEAMMATE_PROVIDER })
      const spawned = await teams.spawnTeammate(caller, {
        name: member,
        description: record.post || name,
        prompt: [{ type: 'text', text: promptText }],
        context: 'fresh',
        //22.2.0.9 显式指定可用的 provider，避免继承到无 adapter 的全局默认
        provider: TEAMMATE_PROVIDER,
        signal: new AbortController().signal,
      })
      //22.2.0.8 创建成功不等于能用：provider 无 adapter 时会立即 failed，必须回传给 UI
      const created = spawned && spawned.member
      const actualProvider = created && created.provider ? created.provider : TEAMMATE_PROVIDER
      if (created && created.status === 'failed') {
        const reason = Array.isArray(created.diagnostics) && created.diagnostics.length > 0
          ? created.diagnostics.join('; ')
          : '创建后立即失败'
        //22.2.0.16 创建后立即 failed 记 state=failed，保留 ok=false 与中文原因
        results.push({ name, ok: false, state: 'failed', reason: '上线失败[' + actualProvider + '] 会话=' + String(caller && caller.id) + '：' + reason })
      } else {
        //22.2.0.18 spawn 成功即 state=online，前端可直接按 online/already 区分「新上线」与「本来就在」
        results.push({ name, ok: true, state: 'online', reason: '已上线[' + actualProvider + '] 会话=' + String(caller && caller.id) })
      }
    } catch (error) {
      //22.2.0.13 失败也带上实际会话与专属会话建立结果，否则无法判断是回退了还是真没建起来
      const reason = error instanceof Error ? error.message : String(error)
      results.push({
        name,
        ok: false,
        //22.2.0.17 spawn 抛错同样是 failed，与「创建后立即 failed」共用同一个 state
        state: 'failed',
        reason: reason + '｜caller=' + String(caller && caller.id) + '｜staffLead=' + (staffLead ? 'ok' : 'null') + '｜lastErr=' + (lastStaffSessionError ? lastStaffSessionError.reason : 'none'),
      })
    }
  }
  log('info', '员工上线', { results: results.map((item) => `${item.name}:${item.reason}`).join(', ') })
  return results
}

//22.2.1 读取请求体：限制 64KB，避免异常大包
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) { reject(new Error('请求体过大')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

//22.2.2 动作分发：复用工具实现，保证 UI 操作与模型调用走同一套校验，不出现两套逻辑
async function handleAction(ctx, action, payload, callerSessionId, principal) {
  const tools = buildTools()
  const find = (name) => tools.find((tool) => tool.name === name)
  const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  //22.2.2.2 用 UI 传的会话解析 Lead；解析不到才退回第一个 root
  let lead
  if (agentsSvc && callerSessionId && typeof agentsSvc.get === 'function') {
    try { lead = agentsSvc.get(callerSessionId) } catch (error) { lead = undefined }
  }
  //22.7.9 自报会话查不到时不再静默回落 roots()[0]：那等于拿别的会话身份继续执行，
  //        比报错更危险（沈固 task-26 的 B4）。enforce 下直接 400，warn/off 保留旧行为只记日志
  if (!lead && callerSessionId && ownership.mode === 'enforce') {
    const unknown = new Error('会话不存在或已结束，请刷新页面后重试')
    unknown.code = 'SESSION_UNKNOWN'
    throw unknown
  }
  if (!lead && callerSessionId && ownership.mode === 'warn') {
    log('warn', '动作携带的会话不存在，按旧行为回落首个根会话', { action, sessionId: String(callerSessionId) })
  }
  if (!lead && agentsSvc && typeof agentsSvc.roots === 'function') lead = agentsSvc.roots()[0]
  //22.2.2.1 Agent Teams 的投递校验要求真实 AbortSignal，undefined 会被 schema 直接拒绝
  const exec = { agent: lead, signal: new AbortController().signal }
  if (action === 'wake') {
    //22.7.11 scope 校验：旧实现遇到非法 scope 会静默唤醒全员（一次点错烧一整队额度），改成显式 400
    const scope = payload && payload.scope
    if (scope !== undefined && scope !== null) {
      const kind = scope && typeof scope.kind === 'string' ? scope.kind : ''
      const invalid = (kind !== 'employee' && kind !== 'group')
        || (kind === 'employee' && !(typeof scope.name === 'string' && scope.name !== ''))
        || (kind === 'group' && !(typeof scope.id === 'string' && scope.id !== ''))
      if (invalid) {
        const badScope = new Error('wake 的 scope 不合法：kind 必须是 employee 或 group，并带上对应的 name/id')
        badScope.code = 'INVALID_SCOPE'
        throw badScope
      }
    }
    return { results: await wakeAllEmployees(ctx, callerSessionId, scope) }
  }
  if (action === 'hire') return find('staff_hire').execute(payload, exec)
  if (action === 'group-create') return find('group_create').execute(payload, exec)
  //22.2.3.0 群管理：解散群、踢成员；员工管理：解雇（归档而非物理删除）
  if (action === 'group-delete') return find('group_delete').execute({ groupId: payload && payload.groupId, confirm: true }, exec)
  if (action === 'group-kick') return find('group_update').execute({ groupId: payload && payload.groupId, removeMembers: [payload && payload.member] }, exec)
  //22.2.3.1 群设置：改名、增删成员、改绑工作区
  if (action === 'group-update') return find('group_update').execute(payload, exec)
  //22.5.0 探针：单独验证 agents.create 能否在 yuangong 工作区建出会话
  if (action === 'probe-create-staff-session') {
    const agents = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('agents') : undefined
    if (!agents || typeof agents.create !== 'function') return { ok: false, reason: 'agents.create 不可用' }
    const member = (payload && payload.member) || 'probe'
    const sessionId = 'staff-' + member
    const out = { sessionId, workspace: STAFF_WORKSPACE }
    //22.5.1 走真实路径：验证 ensureStaffSession 本身能否建出来
    if (payload && payload.useEnsure) {
      try {
        const created = await ensureStaffSession(agents, member)
        out.ensureOk = !!created
        out.ensureAgentId = created ? created.id : null
        out.lastError = lastStaffSessionError
        return out
      } catch (error) {
        out.ensureOk = false
        out.ensureError = error instanceof Error ? error.message : String(error)
        return out
      }
    }
    try {
      const existing = typeof agents.get === 'function' ? agents.get(sessionId) : null
      if (existing) return { ok: true, already: true, ...out }
      const handle = await agents.create({ sessionId: sessionId, meta: { cwd: STAFF_WORKSPACE } })
      out.agentId = handle && handle.agent ? handle.agent.id : null
      out.ok = !!out.agentId
      return out
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), ...out }
    }
  }

  //22.4.0 诊断：报告 Host 侧看到的会话与 Team 现状，用于排查「面板挂错会话」
  //4.2.1 员工归档：把可复用结论写进自己的知识库
  if (action === 'kb-archive') {
    const roster = await readRoster()
    const target = payload && payload.employee
    const record = target ? roster.employees[target] : null
    //4.2.2 未指定员工时按调用者身份推断，避免员工必须记住自己的中文名
    let employeeName = target
    if (!employeeName && exec && exec.agent) {
      const me = resolveSender(exec)
      for (const [name, item] of Object.entries(roster.employees)) {
        if (item.member && item.member === me) { employeeName = name; break }
      }
    }
    if (!employeeName || !roster.employees[employeeName]) throw new Error('无法确定归档对象')
    const result = await archiveToKb(employeeName, payload && payload.text, payload && payload.tag)
    log('info', '员工知识库归档', { employee: employeeName, ok: result.ok, file: result.file })
    return result
  }

  //4.2.3 绑定上下文会话：把员工与某个会话固定关联，后续私聊都投到这个会话
  if (action === 'staff-bind-session') {
    const roster = await readRoster()
    const employeeName = payload && payload.employee
    const record = roster.employees[employeeName]
    if (!record) throw new Error('名册中没有员工「' + String(employeeName) + '」')
    //4.2.3.1 离职员工不再接受工位绑定：绑上去也没有投递路径，只会让快照显示“已绑定但不可用”（qa P2-5）
    if ((record.status ?? 'active') !== 'active') throw new Error('员工「' + String(employeeName) + '」已离职，不能绑定工位')
    record.sessionId = payload.sessionId ? String(payload.sessionId) : null
    record.workspace = staffWorkspacePath(employeeName)
    record.boundAt = new Date().toISOString()
    await writeRoster(roster)
    log('info', '员工绑定上下文会话', { employee: employeeName, sessionId: record.sessionId })
    return { employee: employeeName, sessionId: record.sessionId, workspace: record.workspace }
  }

  if (action === 'whoami') {
    const agents = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('agents') : undefined
    const teams = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('agentTeams') : undefined
    const roots = agents && typeof agents.roots === 'function'
      ? agents.roots().map((agent) => agent.id)
      : []
    const live = agents && typeof agents.list === 'function'
      ? agents.list().map((agent) => agent.id)
      : []
    //22.4.1 传入的 sessionId 是客户端认定自己所在的会话；缺省时回落到请求级 sessionId，不能再恒为 null
    //22.7.10 归属改造后：已认证的会话只认票据/请求级 sessionId，payload.sessionId 降级为 declaredSessionId 回显，
    //         不再覆盖 claimed——否则「谁报谁就是」的老问题会从 whoami 这个口子漏回来
    //22.7.10.4 declared 回显要覆盖两条入口（qa P3-12）：principal.declaredSid 来自 body 顶层
    //          （index.js:2920 → parsed.sessionId），payload.sessionId 只在调试/旧调用里出现；
    //          客户端真实形状是顶层，只读 payload 会让这个字段恒为 null，排障时看起来像「客户端没报」
    const declared = (principal && typeof principal.declaredSid === 'string' && principal.declaredSid !== '')
      ? principal.declaredSid
      : (payload && typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : null)
    const claimed = (principal && principal.sid)
      ? principal.sid
      : (typeof callerSessionId === 'string' && callerSessionId !== '' ? callerSessionId : null)
    //22.7.10.1 枚举面收紧（qa P2-1）：ping 用自报 sessionId 换票，warn 模式下人人可换，
    //          于是 whoami 就成了「任意会话 → 成员名 + 全进程会话 id 列表」的 oracle。
    //          enforce 模式（票据 + 归属已校验）才回身份明细；warn/off 只回数量。
    //          根因不在 whoami，而在 ping 换票没有更强的主体证明——这层诚实写进注释，别把遮蔽当硬安全。
    const revealIdentities = ownership.mode === 'enforce'
    //22.7.10.3 人数同样收口（qa P2-9）：memberCount 是「该会话存在 + 几人在场」的单向 oracle，
    //          warn 下任何人都能自报一个 sessionId 换到人数（1 vs 0 即可枚举会话是否存在）。
    //          只认票据 sid；off 是完全关闭防护的调试模式，此时信息面已无从谈起，
    //          仍允许用请求级 sessionId，否则自检按钮在 off 下永远显示 0 人。
    const countSession = (principal && principal.sid)
      ? principal.sid
      : (ownership.mode === 'off' && typeof callerSessionId === 'string' && callerSessionId !== '' ? callerSessionId : null)
    let members = []
    let memberCount = 0
    if (teams && countSession) {
      const leadAgent = agents && typeof agents.get === 'function' ? agents.get(countSession) : undefined
      if (leadAgent) {
        try {
          const list = teams.listMembers(leadAgent)
          memberCount = Array.isArray(list) ? list.length : 0
          if (revealIdentities) members = list.map((item) => item.name + ':' + item.status)
        } catch (error) {
          if (revealIdentities) members = ['listMembers 失败：' + (error instanceof Error ? error.message : String(error))]
        }
      }
    }
    return {
      claimedSessionId: claimed,
      declaredSessionId: declared,
      ownershipMode: ownership.mode,
      agentCount: live.length,
      rootCount: roots.length,
      //22.7.10.2 roots 原本直接给全进程会话 id：客户端零消费（只有自检按钮用 membersOfClaimed），
      //          纯枚举面，非 enforce 一律不回明细
      roots: revealIdentities ? roots : [],
      memberCount,
      membersOfClaimed: members,
    }
  }
  if (action === 'history') {
    //22.6.1 历史分页：按 seq 向前取（不含 before 本身），前端「加载更早」靠它翻页
    const kind = payload && payload.kind
    if (kind !== 'group' && kind !== 'dm') throw new Error('history 的 kind 必须是 group 或 dm')
    const rawLimit = payload && payload.limit
    //22.6.2 limit 上限 100（与契约一致），缺省 60，非整数按缺省处理
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 60
    const rawBefore = payload && payload.before
    const before = typeof rawBefore === 'number' && Number.isFinite(rawBefore) ? rawBefore : null
    let allMessages = []
    if (kind === 'group') {
      const groupId = payload && typeof payload.id === 'string' && payload.id !== '' ? payload.id : ''
      if (!groupId) throw new Error('history 缺少群 ID（id）')
      const historyGroups = await readGroups()
      const group = historyGroups.groups ? historyGroups.groups[groupId] : undefined
      if (!group) throw new Error(`群 ${groupId} 不存在，先用 group_list 确认`)
      allMessages = Array.isArray(group.messages) ? group.messages : []
    } else {
      const employee = payload && typeof payload.employee === 'string' && payload.employee !== '' ? payload.employee : ''
      if (!employee) throw new Error('history 缺少员工姓名（employee）')
      const historyDms = await readDms()
      const conversation = historyDms.conversations ? historyDms.conversations[employee] : undefined
      if (!conversation) throw new Error(`没有与「${employee}」的私聊记录`)
      allMessages = Array.isArray(conversation.messages) ? conversation.messages : []
    }
    //22.6.3 只保留 before 之前的消息；total 是该会话真实总数，truncated 表示还有更早的可以继续翻
    const pool = before === null ? allMessages : allMessages.filter((item) => item && typeof item.seq === 'number' && item.seq < before)
    const messages = pool.slice(-limit)
    return { messages, total: allMessages.length, truncated: pool.length > messages.length }
  }
  if (action === 'staff-fire') return find('staff_fire').execute({ name: payload && payload.name }, exec)
  if (action === 'group-send') return find('group_send').execute(payload, exec)
  if (action === 'dm') {
    //22.2.3 私聊：先落盘再投递，保证「说过的话」能回看；不写任务账本
    const roster = await readRoster()
    const record = roster.employees[payload.employee]
    if (!record) throw new Error(`名册中没有员工「${payload.employee}」`)
    //22.2.3.1 在职校验：离职员工仍留在名册里（保留档案），但左栏还能点进去私聊，
    //         旧实现会把消息落盘再唤醒已归档工位——群发六处都拦了，唯独私聊漏了这一条（qa P1-1）
    if ((record.status ?? 'active') !== 'active') throw new Error(`员工「${payload.employee}」已离职，不能私聊；需要继续使用请重新 staff_hire`)
    if (!record.member) throw new Error(`员工「${payload.employee}」未绑定工位`)
    const text = String(payload.text || '').trim()
    if (text === '') throw new Error('消息不能为空')
    const dms = await readDms()
    const conversation = dms.conversations[payload.employee] || { seq: 0, messages: [] }
    conversation.seq = (conversation.seq || 0) + 1
    conversation.messages.push({ seq: conversation.seq, from: 'user', text, ts: new Date().toISOString() })
    //22.2.4 只保留最近 200 条，避免长期使用后文件无限增长
    conversation.messages = conversation.messages.slice(-200)
    dms.conversations[payload.employee] = conversation
    await writeDms(dms)
    //22.2.5 私聊是明确单目标投递，成员缺失时允许重建工位自愈（老板点一次 @就有人接活）
    const delivered = await deliverToMember(exec, record.member, text + '\n\n（回复请调用 staff_reply 工具把内容写回来，老板才能在聊天界面看到；只 send_message 给 lead 他看不到。）', { allowRevive: true, record })
    if (!delivered.ok) throw new Error(delivered.reason)
    const out = { delivered: 1, seq: conversation.seq }
    if (delivered.repaired) out.repaired = true
    return out
  }
  throw new Error(`未知动作：${action}`)
}

//22.3 自动驾驶：定时检查待办并唤醒，默认关闭，带每日熔断，重启即失效
//22.3.0 计日统一走 currentDayKey（本地 6 点边界），不再用 UTC 日期：UTC 与本地跨日错位会让当日计数错位（A-08）
async function autopilotTick(ctx) {
  if (!autopilot.enabled) return
  const dayKey = currentDayKey()
  if (autopilot.day !== dayKey) { autopilot.day = dayKey; autopilot.used = 0 }
  if (autopilot.used >= autopilot.dailyLimit) return
  const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  const teams = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
  if (!agentsSvc || typeof agentsSvc.roots !== 'function' || !teams) return
  const lead = agentsSvc.roots()[0]
  if (!lead) return
  //22.3.1 锁内只做认领：挑一名员工把 todo 标成 doing 并记 dispatchedAt，投递放锁外，避免长耗时投递占住名册锁
  let claimed = null
  await rosterStore.mutate((roster) => {
    if (!roster.employees || typeof roster.employees !== 'object') roster.employees = {}
    //22.3.1.1 每轮只派一名员工，避免一次唤醒全部造成费用尖峰
    const entry = Object.entries(roster.employees).find(([, record]) =>
      record && (record.status ?? 'active') === 'active' && record.member && (record.todos ?? []).some((item) => item.status === 'todo'))
    if (!entry) return
    const [name, record] = entry
    const todos = (record.todos ?? []).filter((item) => item && item.status === 'todo')
    const now = new Date().toISOString()
    for (const item of todos) { item.status = 'doing'; item.dispatchedAt = now }
    record.updatedAt = now
    claimed = { name, member: record.member, post: record.post ?? '', todos, ids: todos.map((item) => item.id) }
  })
  if (!claimed) return
  //22.3.2 投递带真实 AbortController.signal：agentTeams 校验 signal 类型时不再因 undefined 抛错（A-05）
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const exec = { agent: lead, signal: controller ? controller.signal : undefined }
  let delivered
  try {
    delivered = await deliverToMember(exec, claimed.member, buildTaskEnvelope(claimed.name, claimed.post, claimed.todos))
  } catch (error) {
    //22.3.2.1 投递函数自身抛错也要归一成失败结果，避免 tick 中断后任务永远停在 doing
    delivered = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!delivered.ok) {
    //22.3.3 投递失败回滚认领：任务回到 todo 并记 lastError，坏工位标记由 deliverToMember 负责，避免任务被吞在 doing（A-05）
    try {
      await rosterStore.mutate((roster) => {
        const record = roster.employees && roster.employees[claimed.name]
        if (!record || !Array.isArray(record.todos)) return
        const now = new Date().toISOString()
        for (const item of record.todos) {
          if (claimed.ids.includes(item.id) && item.status === 'doing') {
            item.status = 'todo'
            item.lastError = String(delivered.reason || '').slice(0, 200)
            item.updatedAt = now
          }
        }
      })
    } catch (error) {
      log('warn', '自动驾驶回滚失败', { name: claimed.name, reason: error instanceof Error ? error.message : String(error) })
    }
    log('warn', '自动驾驶投递失败', delivered.reason)
    return
  }
  autopilot.used += 1
  log('info', '自动驾驶派发', { name: claimed.name, tasks: claimed.todos.length, used: autopilot.used })
}

//22.4 自动驾驶开关
const autopilotTool = {
  name: 'staff_autopilot',
  description: '开启/关闭自动驾驶：每分钟检查待办并唤醒一名员工。默认关闭，带每日次数上限。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['on', 'off', 'status'], description: 'on 开启 / off 关闭 / status 查看' },
      dailyLimit: { type: 'number', description: '可选：每日最多自动派发次数，默认 20' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        used: { type: 'number' },
        dailyLimit: { type: 'number' },
        message: { type: 'string' },
      },
    },
    render(args, value) {
      return [{ type: 'text', text: value && value.message ? value.message : '自动驾驶状态' }]
    },
  },
  async execute(args) {
    const action = requireText(args, 'action', '动作')
    if (!['on', 'off', 'status'].includes(action)) throw new Error('action 只能是 on/off/status')
    if (typeof args.dailyLimit === 'number' && args.dailyLimit > 0) autopilot.dailyLimit = Math.floor(args.dailyLimit)
    //22.4.1 与 tick 用同一个本地 6 点边界计日，开关状态里的 used 不会因 UTC 跨日提前清零（A-08）
    const dayKey = currentDayKey()
    if (autopilot.day !== dayKey) { autopilot.day = dayKey; autopilot.used = 0 }
    if (action === 'on') autopilot.enabled = true
    if (action === 'off') autopilot.enabled = false
    const state = autopilot.enabled ? '已开启' : '已关闭'
    const warning = autopilot.enabled ? '\n注意：开启后每分钟最多唤醒 1 名员工，每次都会真实计费。' : ''
    return {
      enabled: autopilot.enabled,
      used: autopilot.used,
      dailyLimit: autopilot.dailyLimit,
      message: `自动驾驶${state}。今日已派发 ${autopilot.used}/${autopilot.dailyLimit} 次。${warning}`,
    }
  },
}

//22. 插件入口：逐个注册工具，全部走 ctx.effect 以便卸载/HMR 时精确回收
export function apply(ctx) {
  hostCtx = ctx
  const tools = buildTools()
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  registerHttpRoutes(ctx)
  //22.5 自动驾驶定时器：随插件卸载清理，避免 HMR 后多个定时器叠加导致重复唤醒
  ctx.effect(() => {
    const timer = setInterval(() => {
      autopilotTick(ctx).catch((error) => log('warn', '自动驾驶 tick 失败', error instanceof Error ? error.message : String(error)))
    }, 60000)
    return () => clearInterval(timer)
  })
  log('info', '员工制插件已激活', { tools: tools.map((tool) => tool.name).join(', '), roster: ROSTER_PATH, groups: GROUP_PATH })
}
