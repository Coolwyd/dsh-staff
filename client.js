// 员工制客户端：DSH 内的「员工中心」，聊天式界面。
// 左侧会话列表（私聊 + 群），右侧气泡对话，全部使用 DSH 主题变量。
window.__ModuleLoader__.load({
  //2.0 模块 id 必须与 package.json 的 name 完全一致，否则客户端模块不注册、UI 直接消失
  id: 'dsh-staff',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    //1. 轮询间隔
    const POLL_MS = 15000

    //2. 跨 slot 共享的面板开关
    const panelStore = { open: false, listeners: new Set() }
    function setPanelOpen(next) {
      panelStore.open = next
      for (const listener of panelStore.listeners) listener(next)
    }
    function usePanelOpen() {
      const [open, setOpenState] = useState(panelStore.open)
      useEffect(() => {
        panelStore.listeners.add(setOpenState)
        return () => { panelStore.listeners.delete(setOpenState) }
      }, [])
      return open
    }

    //2.1 状态带持久状态：位置与是否隐藏，存 localStorage，只影响这条显示，不影响插件
    const barStore = {
      hidden: (function () {
        try { return localStorage.getItem('dsh-staff-bar-hidden') === '1' } catch (error) { return false }
      })(),
      pos: (function () {
        try {
          const raw = localStorage.getItem('dsh-staff-bar-pos')
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
          }
        } catch (error) { /* 落到默认值 */ }
        return { x: 0, y: 0 }
      })(),
      listeners: new Set(),
    }
    function setBarHidden(next) {
      barStore.hidden = next
      try { localStorage.setItem('dsh-staff-bar-hidden', next ? '1' : '0') } catch (error) { /* 忽略存储失败 */ }
      for (const listener of barStore.listeners) listener(next)
    }
    function useBarHidden() {
      const [hidden, setHidden] = useState(barStore.hidden)
      useEffect(() => {
        barStore.listeners.add(setHidden)
        return () => { barStore.listeners.delete(setHidden) }
      }, [])
      return hidden
    }

    //2.2 当前会话 id：由输入区状态带从 props 捕获，用于让 Host 知道「是哪个窗口在操作」
    //    没有它时 Host 会退回第一个会话，多窗口下员工就会挂错地方
    let currentSessionId = null
    //17.8.1 服务端会话票据：client-ping 下发（32 位 hex）；为 null 表示 off 模式，此时任何请求都不带 x-staff-token
    let staffToken = null
    //17.8.12 服务端会话票据：client-ping 带 ?sessionId=<当前会话> 才下发（10 分钟 TTL），动作请求必须带
    //         x-staff-session-ticket。token 证明「是本页」，票据证明「是哪个会话」，两者分开存：
    //         off 模式票据恒为 null，请求头与改造前完全一致
    let staffSessionTicket = null
    let staffSessionTicketExpiresAt = 0
    let staffSessionTicketSessionId = null
    //17.8.12.1 提前 30 秒换票：票据 10 分钟到期，卡在临界点再换会白吃一次 401；
    //          30 秒既覆盖请求往返，又不会让 ping 变频繁（正常情况下 10 分钟才一次）
    const TICKET_REFRESH_MARGIN_MS = 30 * 1000
    //17.8.12.2 ping 单飞：快照轮询与动作可能同时要换票，同一时刻只允许一个 ping 在飞，避免连打
    let staffTokenFlight = null
    //2.2 客户端上下文引用：主面板切换需要 ctx.layout.selectPanel
    let clientCtx = null
    //2.3 layout 服务读取：优先 ctx.get（optional 访问），再退回 ctx.layout；未注入时返回 undefined
    //10.0.1 取 uiWorkspace 服务：用于在指定工作区开启新会话
    function uiWorkspaceService() {
      if (!clientCtx) return undefined
      if (typeof clientCtx.get === 'function') {
        try {
          const service = clientCtx.get('uiWorkspace')
          if (service) return service
        } catch (error) { /* 继续尝试直接属性 */ }
      }
      return clientCtx.uiWorkspace
    }
    //10.0.2 取 workspaces 服务：路径不在工作区列表时用它补建
    function workspacesService() {
      if (!clientCtx) return undefined
      if (typeof clientCtx.get === 'function') {
        try {
          const service = clientCtx.get('workspaces')
          if (service) return service
        } catch (error) { /* 继续尝试直接属性 */ }
      }
      return clientCtx.workspaces
    }
    //10.0.3 取 conversation 服务：输入框归属该服务，/ 菜单选中员工后要把对象写进当前草稿
    function conversationService() {
      if (!clientCtx) return undefined
      if (typeof clientCtx.get === 'function') {
        try {
          const service = clientCtx.get('conversation')
          if (service) return service
        } catch (error) { /* 继续尝试直接属性 */ }
      }
      return clientCtx.conversation
    }
    function layoutService() {
      if (!clientCtx) return undefined
      if (typeof clientCtx.get === 'function') {
        try {
          const service = clientCtx.get('layout')
          if (service) return service
        } catch (error) { /* 继续尝试直接属性 */ }
      }
      return clientCtx.layout
    }
    function showStaffPanel() {
      const service = layoutService()
      if (!service || typeof service.selectPanel !== 'function') return false
      service.selectPanel('staff')
      return true
    }
    function showConversationPanel() {
      const service = layoutService()
      if (!service || typeof service.selectPanel !== 'function') return false
      service.selectPanel('conversation')
      return true
    }

    //3. 快照拉取
    //17.8.2 票据头：token 为空返回 null，调用方据此不写 headers 键，保证 off 模式请求字节不变
    function staffTokenHeaders() {
      return staffToken ? { 'x-staff-token': staffToken } : null
    }
    //17.8.3 快照请求参数：只有拿到票据时才加 headers，避免给 off 模式多挂一个空对象
    function snapshotInit() {
      const init = { credentials: 'same-origin' }
      const auth = staffTokenHeaders()
      if (auth) init.headers = auth
      return init
    }
    //17.8.12.3 票据头：无票就不写 headers 键（off 模式字节级不变，口径同 17.8.2）
    function staffSessionTicketHeaders() {
      return staffSessionTicket ? { 'x-staff-session-ticket': staffSessionTicket } : null
    }
    //17.8.12.4 当前会话 id：只认 props 带进来的真实值，不写死、也不用请求体里的声明值兜底
    function currentSessionIdOf() {
      return typeof currentSessionId === 'string' && currentSessionId !== '' ? currentSessionId : ''
    }
    //17.8.12.5 票据是否要换：没票、会话变了、离过期不足 30 秒，三种都算
    function ticketNeedsRefresh() {
      if (!staffSessionTicket) return true
      if (staffSessionTicketSessionId !== currentSessionIdOf()) return true
      return Date.now() >= staffSessionTicketExpiresAt - TICKET_REFRESH_MARGIN_MS
    }
    //17.8.4 ping 顺带续票：失败静默，Host 重启期间 token 保持旧值，由 401 自愈再补一次
    //17.8.13 ping 带 sessionId：Host 按它签会话票据；会话还没就绪时不带该参数，Host 也就发票据，
    //        动作请求自然没有票据头（off 模式/未选会话都不受影响）。单飞避免轮询与动作同时换票
    function refreshStaffToken() {
      if (staffTokenFlight) return staffTokenFlight
      const sid = currentSessionIdOf()
      const url = '/staff-api/client-ping?from=react' + (sid ? '&sessionId=' + encodeURIComponent(sid) : '')
      staffTokenFlight = fetch(url, { credentials: 'same-origin' })
        .then(function (res) { return res && res.ok ? res.json() : null })
        .then(function (data) {
          if (!data) return
          if (typeof data.token === 'string' && data.token) staffToken = data.token
          //17.8.13.1 票据三字段一起更新：只认本次 ping 声明的会话，避免上一轮留下的票被当成本会话的
          if (typeof data.ticket === 'string' && data.ticket) {
            staffSessionTicket = data.ticket
            staffSessionTicketSessionId = typeof data.ticketSessionId === 'string' && data.ticketSessionId !== '' ? data.ticketSessionId : sid
            const expires = Date.parse(String(data.ticketExpiresAt || ''))
            staffSessionTicketExpiresAt = isNaN(expires) ? 0 : expires
          } else {
            //17.8.13.2 Host 明确没发票据（off 模式/没带 sessionId）：清掉旧票，免得拿过期票去撞 401
            staffSessionTicket = null
            staffSessionTicketSessionId = null
            staffSessionTicketExpiresAt = 0
          }
        })
        .catch(function () {})
        .then(function () { staffTokenFlight = null })
      return staffTokenFlight
    }
    function useSnapshot() {
      const [snap, setSnap] = useState(null)
      const [failed, setFailed] = useState(false)
      const load = useCallback(async () => {
        try {
          //17.8.5 带票据快照：无 token 时 snapshotInit 与原参数完全一致
          let res = await fetch('/staff-api/snapshot', snapshotInit())
          //17.8.11 快照 401 自愈：Host 重启会换票，页面继续拿旧票轮询就是次次 401，且永不恢复。
          //         这里与动作请求同口径——先换票再重发一次；快照是纯读接口，重发不产生副作用，
          //         所以不需要 17.8.10 的动作白名单（那条白名单是给会落盘/投递的动作用的）。
          if (res.status === 401) {
            await refreshStaffToken()
            res = await fetch('/staff-api/snapshot', snapshotInit())
          }
          //17.8.11.1 换票后仍失败（票被踢下线 / 服务端没开票据 / 其他错误）才置失败态。
          //          这里只记「失败」布尔，由调用方按「有没有旧快照」区分首屏失败与陈旧数据——
          //          两种情况提示完全不同，混在一起就会出现「对着旧数据以为是新的」（qa P1-1）
          if (!res.ok) { setFailed(true); return }
          setSnap(await res.json())
          setFailed(false)
        } catch (error) {
          setFailed(true)
        }
      }, [])
      //17.8.11.2 reload 的语义是「立刻重试」：先 ping 换票，再拉快照。
      //          旧票直接重发只是白跑一趟，先换票才能一次成功；轮询仍走 load（不在每 15 秒都多打一次 ping）
      async function reload() {
        await refreshStaffToken()
        await load()
      }
      useEffect(() => {
        //3.1 心跳上报兼取票：先 ping 拿 token 再拉快照，否则 enforce 模式下首帧必 401
        //17.8.6 ping 失败也照常 load：off 模式没有 token 属正常，不能因此卡住列表
        refreshStaffToken().then(function () { load() })
        const timer = setInterval(load, POLL_MS)
        return () => clearInterval(timer)
      }, [load])
      return { snap, failed, reload: reload }
    }

    //4. 动作调用
    //17.8.10 401 重放白名单：服务端 handleAction 只有 whoami / history 是纯读，其余都会落盘或投递。
    //         写动作重放 = dm 发两遍、hire 建两条、group-send 重复投递，所以重放必须按动作类型收口。
    const READ_ACTIONS = { whoami: true, history: true }
    //17.8.10.1 写动作显式列举（对应 index.js handleAction 的每个写分支）：列出来是为了让后来新增动作
    //          有地方归档，也方便审计「哪些动作绝不能重放」。
    const WRITE_ACTIONS = {
      wake: true,
      hire: true,
      'group-create': true,
      'group-delete': true,
      'group-kick': true,
      'group-update': true,
      'group-send': true,
      'staff-fire': true,
      'staff-bind-session': true,
      'kb-archive': true,
      'probe-create-staff-session': true,
      dm: true,
    }
    //17.8.10.2 重放判定：必须同时「在读白名单」且「不在写集合」，未知动作一律按写处理（fail-closed）——
    //          将来新增动作若没登记，代价只是多一次「请刷新页面」，不会变成重复投递。
    function canReplayAction(action) {
      return READ_ACTIONS[action] === true && WRITE_ACTIONS[action] !== true
    }
    //17.8.14 挑战码目标：必须与服务端 confirmTargetOf 的取值顺序一致（groupId → id → name → employee → member）。
    //         两边任意一边改了顺序，挑战码就对不上，破坏性动作会一直卡在 428——这是最容易漏的耦合点
    function confirmTargetOf(payload) {
      const order = ['groupId', 'id', 'name', 'employee', 'member']
      const data = payload || {}
      for (let i = 0; i < order.length; i += 1) {
        const value = data[order[i]]
        if (typeof value === 'string' && value !== '') return value
      }
      return ''
    }
    //17.8.14.1 取挑战码：GET /staff-api/confirm 同样要带 token 与票据；取不到码必须抛出可读文案，
    //           不能静默返回空串让上层再吃一次 428（那样用户只会看到「需要二次确认」却无从确认）
    //17.8.14.3 危险字段声明：group-update 是否需要二次确认，取决于「本次请求里有没有 workspace/secretary」。
    //          服务端 confirm 路由只拿到 action+target，判不了这件事，所以由这里显式声明：
    //          fields=workspace 表示确实在改工作区；fields=- 表示这次只改名/加人，不该弹确认。
    //          漏了这个参数服务端会保守按「要确认」处理——不会死锁，但会让改名也弹框，体验退化。
    const DANGER_FIELDS = ['workspace', 'secretary']
    function dangerFieldsOf(payload) {
      const data = payload || {}
      const hit = []
      for (let i = 0; i < DANGER_FIELDS.length; i += 1) {
        if (data[DANGER_FIELDS[i]] !== undefined) hit.push(DANGER_FIELDS[i])
      }
      return hit.length > 0 ? hit.join(',') : '-'
    }
    async function fetchConfirmChallenge(action, payload) {
      const url = '/staff-api/confirm?action=' + encodeURIComponent(action)
        + '&target=' + encodeURIComponent(confirmTargetOf(payload))
        + '&fields=' + encodeURIComponent(dangerFieldsOf(payload))
      const build = () => {
        const headers = Object.assign({}, staffTokenHeaders(), staffSessionTicketHeaders())
        const init = { credentials: 'same-origin' }
        if (Object.keys(headers).length > 0) init.headers = headers
        return fetch(url, init)
      }
      let res = await build()
      //17.8.14.2 票据刚过期的边界：换票后重试一次即可；confirm 是纯读接口，重发无副作用
      if (res.status === 401) {
        await refreshStaffToken()
        res = await build()
      }
      const body = await res.json().catch(() => ({}))
      //17.8.14.4 取码返回对象三态（P3-11）：
      //          ①命中挑战 → { challenge: '<32hex>' }；
      //          ②服务端 required:false（HTTP 200、无挑战）是正常结论，返回 { challenge: '' }——
      //            原先这里抛「二次确认失败：HTTP 200」，把「不需要确认」误报成故障，用户按提示刷新也不会有变化；
      //          ③其他失败（非 200 / 带 body.error）照旧抛可读错误，文案保留原文
      if (res.ok && body && body.required === false) return { challenge: '' }
      if (!res.ok || !body || typeof body.challenge !== 'string' || body.challenge === '') {
        throw new Error('二次确认失败：' + ((body && body.error) || ('HTTP ' + res.status)))
      }
      return { challenge: body.challenge }
    }
    async function callAction(action, payload) {
      //17.8.15 动作前续票：票据 10 分钟、离过期 30 秒内先换。只在「已有票但快过期/会话变了」时 ping；
      //         没票时不主动 ping——那会退化成每个动作多一次空 ping（off 模式尤其明显），
      //         没票的情况交给票据 401 自愈补一次（见 17.8.16），代价只有首次动作多一个来回
      if (staffSessionTicket && ticketNeedsRefresh()) await refreshStaffToken()
      //17.8.7 每次重放都重新拼 headers：401 自愈后用新票据，且 token 为空时不会多出空的 headers 键
      //17.8.15.1 票据头与令牌头合并：两者都为空时不追加多余键，off 模式请求与改造前一致
      const send = (confirmCode) => {
        const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, staffTokenHeaders(), staffSessionTicketHeaders())
        //17.8.15.2 确认码只在重发时带：服务端按 sid|action|target 记账，首次请求带空头没有意义
        if (confirmCode) headers['x-staff-confirm'] = confirmCode
        const init = {
          method: 'POST',
          credentials: 'same-origin',
          headers: headers,
          body: JSON.stringify({ action: action, payload: payload || {}, sessionId: currentSessionId || undefined }),
        }
        return fetch('/staff-api/action', init)
      }
      let res = await send()
      let data = null
      //17.8.8 票据失效自愈：只有幂等读动作重新 ping 取票后重放一次；写动作见 17.8.8.2
      if (res.status === 401) {
        data = await res.json().catch(() => ({}))
        //17.8.16 会话票据类 401：服务端在读体与业务之前就拒（index.js 22.7.5），请求根本没进业务，
        //         所以写动作也能安全重放一次。这与 17.8.10 的写动作白名单并不冲突：
        //         白名单管的是「业务可能已执行」的 token 401，票据 401 连请求体都没被读取
        if (data && (data.code === 'SESSION_TICKET_REQUIRED' || data.code === 'SESSION_TICKET_INVALID' || data.code === 'SESSION_TICKET_EXPIRED')) {
          await refreshStaffToken()
          res = await send()
          //17.8.16.1 换票后仍 401：会话本身立不住（没选会话/被踢下线），用服务端文案提示，不再重试
          if (res.status === 401) {
            data = await res.json().catch(() => ({}))
            throw new Error((data && data.error) || '会话票据已失效，请刷新页面')
          }
          data = null
        } else if (data && (data.code === 'UNAUTHORIZED' || data.code === 'UNAUTHORIZED_STALE')) {
          //17.8.8.2 写动作/未知动作：只把内存票据换成新的，业务请求一次都不重放。
          //          换票是为了让用户点「重试」时首个请求就带新票，不必再吃一次 401。
          if (!canReplayAction(action)) {
            await refreshStaffToken()
            throw new Error('登录态已失效，请刷新页面后重试')
          }
          await refreshStaffToken()
          res = await send()
          //17.8.8.1 换票后仍 401：说明不是票的问题（被踢下线/服务端未开启票据），提示刷新而不是继续重试
          if (res.status === 401) throw new Error('登录态已失效，请刷新页面')
          data = null
        }
      }
      if (data === null) data = await res.json().catch(() => ({}))
      //17.8.17 428 二次确认（index.js 22.7.3/22.7.8）：破坏性动作先在 /staff-api/confirm 换挑战码，
      //         再带 x-staff-confirm 重发一次。挑战码 120 秒且单次消费，所以这里只允许重发一次，绝不循环
      if (res.status === 428 && data && data.code === 'CONFIRM_REQUIRED') {
        const got = await fetchConfirmChallenge(action, payload)
        //17.8.17.2 取码说「不需要确认」时用空码重发（got.challenge 为 '' → send 不带 x-staff-confirm 头）：
        //          执行侧认了就是正常完成；仍回 428 才说明取码侧与执行侧判定不一致，报一句可执行的刷新提示。
        //          全程仍只重发一次，不因为「没拿到码」再回头取第二张
        res = await send(got.challenge)
        data = await res.json().catch(() => ({}))
        //17.8.17.1 重发仍 428（码过期/已被消费）：不再换第二张，把服务端文案抛出去，避免死循环
        if (res.status === 428) {
          if (!got.challenge) throw new Error('服务端确认状态不一致（取码返回不需要确认，执行仍要求确认），请刷新页面后重试')
          throw new Error((data && data.error) || '二次确认已失效，请重试')
        }
      }
      //17.8.18 403 一律不重试：归属不符、票据与会话不一致、确认凭据无效都属于「重试也没用」，
      //         直接展示服务端文案（如「当前会话无权执行该动作」），把判断权交回人
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status))
      return data.result
    }

    //5. 主题 token
    const T = {
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      //14.0.31 品牌底上的前景文字色：宿主真实主题里该变量亮色为白、暗色为近黑（已在 app.asar 内核对
      //        --dsw-alias-label-primary-foreground 映射到 --dsw-static-neutral-bluish-00/1000），
      //        原先 10 处写死白字在暗色品牌底上对比不足，交给主题变量按主题取值
      labelOnBrand: 'var(--dsw-alias-label-primary-foreground)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    //14.0.39 点击区下限（审计 P2-4）：一批按钮的 padding 只有 '0 2px'/'0 4px'，命中区高度≈行高（实测约 22px），
    //        触屏和手不稳的用户要点两三次才中。抽统一命中区批量替换，不改布局结构，也不靠负 margin 骗高度。
    //        刻意不放进 T：T 是设计 token 表，门禁只允许 var(--…) 主题值（20-ui-tokens 会判违规），结构常量单独放
    const HIT = {
      minWidth: 28, minHeight: 28, boxSizing: 'border-box',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: '4px 6px',
    }

    //14.0.40 失败态文案单一来源（审计 P2-6）：同一件事原来有三套说法——「员工制：接口不可用」
    //        「员工接口不可用，正在自动重试…」「员工接口刷新失败」，按钮一个叫「立即重试」一个叫「立即刷新」，
    //        用户以为是三个不同故障。统一到 COPY：同一故障同一句标题、同一个按钮词，陈旧条只多一句过期限定语
    const COPY = {
      apiDown: '员工接口不可用',
      apiDownNote: '正在自动重试…',
      staleNote: '数据可能已过期：员工接口刷新失败，正在自动重试…',
      staleHint: '员工接口最近一次刷新失败，列表仍是上一次成功拉到的数据',
      retry: '立即重试',
      statusFailed: '员工制：接口不可用',
      statusLoading: '员工制：加载中…',
    }

    //14.0.42 视口宽度读取收敛到一处：初始渲染与 resize 回调必须同一口径，
    //        否则「拖窗后窄屏」和「冷启动即窄屏」会算出两种左栏宽度
    function readViewportWidth() {
      if (typeof window === 'undefined') return 1280
      const width = Number(window.innerWidth)
      return width > 0 ? width : 1280
    }

    //6. 头像配色：名字散列到固定调色板，保证同一个人颜色稳定
    const AVATAR_COLORS = ['#5B8FF9', '#61DDAA', '#7262FD', '#F6BD16', '#78D3F8', '#E8684A', '#6DC8EC', '#9270CA']
    function avatarColor(name) {
      let hash = 0
      for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997
      return AVATAR_COLORS[hash % AVATAR_COLORS.length]
    }
    function Avatar(props) {
      const size = props.size || 32
      const initial = (props.name || '?').slice(0, 1)
      return h('div', {
        style: {
          width: size, height: size, borderRadius: '50%', flex: '0 0 auto',
          background: avatarColor(props.name || '?'), color: T.labelOnBrand,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.round(size * 0.42), fontWeight: 600, userSelect: 'none',
        },
      }, initial)
    }

    //7. 时间：只显示时:分，跨天不区分（会话流足够直观）
    function timeOf(ts) {
      if (!ts) return ''
      const d = new Date(ts)
      if (Number.isNaN(d.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    //8. 气泡：我方右对齐品牌色，对方左对齐浅底；带头像与时间
    function Bubble(props) {
      const mine = props.mine
      return h('div', {
        //10.2.0 气泡右键：复制内容、@此人、发私聊
        onContextMenu: props.onContextMenu || undefined,
        style: {
          display: 'flex', gap: 8, marginBottom: 12,
          flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-start',
        },
      },
        h(Avatar, { name: props.sender, size: 30 }),
        h('div', { style: { maxWidth: '68%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' } },
          h('div', { style: { fontSize: 11, color: T.label2, marginBottom: 3 } }, props.sender + ' · ' + timeOf(props.ts)),
          h('div', {
            style: {
              padding: '8px 12px', fontSize: 13, lineHeight: 1.55,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              borderRadius: mine ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
              background: mine ? T.brand : T.layer2,
              color: mine ? T.labelOnBrand : T.label1,
              border: mine ? 'none' : '1px solid ' + T.border1,
            },
          }, props.text)))
    }

    //13.0.11 任务行：档案页「未完成任务」的展示单元
    //       入参 task 来自快照 employees[].open（{ id, text, status, priority, due }），
    //       历史数据可能缺字段，这里一律兜底：宁可显示「（无标题任务）」，也不能让整页白屏
    function TaskRow(props) {
      const task = props && props.task ? props.task : {}
      const title = String(task.text || task.title || '（无标题任务）')
      const STATUS_META = {
        todo: { label: '待办', color: T.label2 },
        doing: { label: '进行中', color: T.brand },
        done: { label: '完成', color: T.ok },
        blocked: { label: '阻塞', color: T.danger },
      }
      //13.0.11.1 未知状态原样显示：以后新增状态时不会静默丢标签，也不会因为查不到映射而报错
      const rawStatus = String(task.status || 'todo')
      const statusMeta = STATUS_META[rawStatus] || { label: rawStatus, color: T.label2 }
      const PRIORITY_META = { high: { label: '高优', color: T.danger }, low: { label: '低优', color: T.label2 } }
      //13.0.11.2 normal 是默认优先级，不占位，避免每行都挂一个没有信息量的标签
      const priorityMeta = PRIORITY_META[String(task.priority || 'normal')] || null
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12, color: T.label1 },
      },
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
        priorityMeta ? h('span', { style: { flex: '0 0 auto', fontSize: 11, color: priorityMeta.color } }, priorityMeta.label) : null,
        h('span', { style: { flex: '0 0 auto', fontSize: 11, color: statusMeta.color, border: '1px solid ' + T.border1, borderRadius: 8, padding: '1px 6px' } }, statusMeta.label),
        task.due ? h('span', { style: { flex: '0 0 auto', fontSize: 11, color: T.label2 } }, String(task.due)) : null)
    }

    //14.0 未读位点：localStorage 只存"读到哪一条"，未读数每次由快照全量重算，避免与 15s 轮询叠加造成重复计数
    const SEEN_KEY_PREFIX = 'dsh-staff-seen:'
    function readSeenPoint(key) {
      // 位点缺失或损坏一律按"未读过"处理（seq 0），保证首次使用不会把历史消息误标为已读
      try {
        const raw = localStorage.getItem(SEEN_KEY_PREFIX + key)
        if (!raw) return { at: 0, seq: 0 }
        const parsed = JSON.parse(raw)
        return {
          at: typeof parsed.at === 'number' ? parsed.at : 0,
          seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
        }
      } catch (error) { return { at: 0, seq: 0 } }
    }
    function writeSeenPoint(key, messages) {
      // 位点只前进不回退：快照条数变少、消息乱序或本地历史被截断时，若直接用本次最大值覆盖，
      // 已读过的旧消息会被重新计为未读；因此与已存 seq 取较大者，进入时刻仅作审计
      let maxSeq = 0
      for (const message of messages) {
        if (typeof message.seq === 'number' && message.seq > maxSeq) maxSeq = message.seq
      }
      const previous = readSeenPoint(key)
      const nextSeq = maxSeq > previous.seq ? maxSeq : previous.seq
      try { localStorage.setItem(SEEN_KEY_PREFIX + key, JSON.stringify({ at: Date.now(), seq: nextSeq })) } catch (error) { /* 存储不可用时只影响本次会话的未读显示 */ }
    }
    function unreadOf(key, messages, activeKey) {
      // 正在看的会话恒为 0，避免"边看边涨"；其余按 seq 比较全量重算，不做累加
      //14.0.30.1 activeKey 必须是「用户显式选中」的值：调用方传兜底值会把没点开的会话未读吞成 0
      if (key === activeKey) return 0
      const seen = readSeenPoint(key)
      let count = 0
      for (const message of messages) {
        const seq = typeof message.seq === 'number' ? message.seq : 0
        if (seq > seen.seq) count += 1
      }
      return count
    }

    //14.0 工位三态归一：新快照直接给 station；旧快照只带 member/online 时按同一定义现算
    //     提成工厂级函数，列表分组、档案页文案、"/" 菜单描述共用一套判定，避免三处口径漂移
    function employeeStationOf(item) {
      if (item && (item.station === 'online' || item.station === 'missing' || item.station === 'unbound')) return item.station
      if (!item) return 'unbound'
      if (!item.member) return item.online ? 'online' : 'unbound'
      return item.online ? 'online' : 'missing'
    }

    //14.0.1 提示分级：ok=成功、warn=部分成功/提醒、error=失败
    //       历史调用点只传 ok 布尔，这里统一归一，避免「5 人成功 1 人失败」整条报红把人吓住
    function noticeLevelOf(notice) {
      if (!notice) return 'ok'
      if (notice.level === 'warn' || notice.level === 'error' || notice.level === 'ok') return notice.level
      return notice.ok === false ? 'error' : 'ok'
    }
    function noticeTone(level) {
      if (level === 'warn') return { color: T.warn, badge: '!', background: 'var(--dsw-alias-bg-layer-2)' }
      if (level === 'error') return { color: T.danger, badge: '×', background: 'var(--dsw-alias-bg-layer-2)' }
      return { color: T.ok, badge: '✓', background: 'transparent' }
    }

    //14.0.19 提示生命周期：成功级 4 秒自动消失，warn/error 常驻但可手动关闭。
    //        「提示永不消失」会让操作区长期被一条横幅占着，切会话后更是误导（qa P1-3）
    const NOTICE_OK_TTL_MS = 4000
    //14.0.20 名册外成员警示文案：members 已过滤成名册内的人，悬空名单单独给，事实必须让管理员看见
    function danglingWarningOf(names) {
      const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name !== '') : []
      if (list.length === 0) return null
      return '有 ' + list.length + ' 人不在名册：' + list.join('、') + '（数据需人工修）'
    }
    //14.0.29 群成员上限：后端 index.js 的校验是 2–8，界面文案却写 2–6 且只拦下限，
    //        用户勾到 9 人提交后才吃一次后端的 400。上限提到工厂级常量，校验与文案共用一处
    const GROUP_MEMBER_LIMIT = 8

    //14.0.35 键盘焦点可见：18 个按钮都用 all:'unset' 抹平了默认样式（焦点轮廓一并被清掉），4 个输入框又显式
    //         outline:'none'，Tab 走一圈完全看不出焦点落在哪。统一用这两个处理器补 2px 品牌色轮廓；
    //         不走注入全局样式表的路子，避免污染宿主其它区域的焦点样式
    function focusRingOn(event) {
      if (!event || !event.currentTarget || !event.currentTarget.style) return
      event.currentTarget.style.outline = '2px solid ' + T.brand
      event.currentTarget.style.outlineOffset = '2px'
    }
    function focusRingOff(event) {
      if (!event || !event.currentTarget || !event.currentTarget.style) return
      event.currentTarget.style.outline = 'none'
      event.currentTarget.style.outlineOffset = '0'
    }

    //14.0.5 首屏骨架：快照未到先占位，避免闪一屏「还没有会话」把加载中误读成空数据
    //       骨架条圆角 5 不属于设计 token 的圆角集合（4/6/8/10…），SkeletonRow 与 SkeletonDetail 两处
    //       统一改成 6：视觉几乎无差，但可被静态门禁校验，避免「看一眼没问题」就绕过
    function SkeletonRow(props) {
      return h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 6px', opacity: props && props.dim ? 0.5 : 0.75 } },
        h('div', { style: { width: 32, height: 32, borderRadius: '50%', flex: '0 0 auto', background: T.layer2, border: '1px solid ' + T.border1 } }),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { height: 10, width: '52%', borderRadius: 6, background: T.layer2 } }),
          h('div', { style: { height: 8, width: '34%', borderRadius: 4, background: T.layer2 } })))
    }
    function SkeletonList(props) {
      const rows = []
      const count = props && props.rows ? props.rows : 5
      for (let i = 0; i < count; i += 1) rows.push(h(SkeletonRow, { key: 'sk-' + i, dim: i > 2 }))
      return h('div', { 'aria-busy': 'true', 'data-staff-skeleton': 'list' }, rows)
    }

    //14.0.8 右栏详情骨架：档案页在首屏快照未到时先占位，
    //       避免右栏先闪一屏「选择左侧会话开始」再突然换成内容，也避免把「加载中」读成「暂无」
    function SkeletonDetail(props) {
      const rows = []
      const count = props && props.rows ? props.rows : 3
      for (let i = 0; i < count; i += 1) rows.push(h(SkeletonRow, { key: 'dk-' + i, dim: i > 1 }))
      return h('div', { 'aria-busy': 'true', 'data-staff-skeleton': 'detail', style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } },
        h('div', { style: { padding: '12px 16px', borderBottom: '1px solid ' + T.border1, display: 'flex', alignItems: 'center', gap: 12 } },
          h('div', { style: { width: 32, height: 32, borderRadius: '50%', flex: '0 0 auto', background: T.layer2, border: '1px solid ' + T.border1 } }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { height: 10, width: 120, borderRadius: 6, background: T.layer2 } }),
            h('div', { style: { height: 8, width: 80, borderRadius: 4, background: T.layer2 } }))),
        h('div', { style: { flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 10 } }, rows))
    }

    //14.0.9 状态点三态归一：在线=绿、工位缺失=橙（可重建）、未绑定=灰
    //       列表行与群成员条共用这一份，颜色之外 title 里写清处置动作，避免两处口径漂移
    function stationDotOf(station) {
      if (station === 'online') return { color: T.ok, title: '在线待命' }
      if (station === 'missing') return { color: T.warn, title: '工位缺失：发消息或点 ↑ 会自动重建' }
      return { color: T.idle, title: '未绑定工位' }
    }

    //9. 会话列表项
    //14.1 员工卡字段：头像 36 + 姓名 13/600 + 摘要 11，右侧 42 宽角标位放未读与待办；上下 8 padding 让卡片高稳定在 52
    function ConversationItem(props) {
      const active = props.active
      const [hovered, setHovered] = useState(false)
      //14.0.35.1 键盘可达：hovered 只是鼠标语义，Tab 落到行上时动作按钮不渲染 = 键盘用户无法上线/私聊。
      //         补 focused 态与 hovered 取并集；blur 时若焦点只是移进本行的动作按钮则不收起，避免按钮消失导致焦点丢失
      const [focused, setFocused] = useState(false)
      //10.0.2 状态点三态：在线=绿、工位缺失=橙（可重建）、未绑定=灰；颜色之外 title 里写清处置动作
      //14.0.9.1 判定收敛到 stationDotOf：列表行不再自带一份三态表，群成员条直接用同一份
      const dot = stationDotOf(props.station || (props.online === undefined ? null : (props.online ? 'online' : 'missing')))
      //14.2 悬停动作：未选中时用「上线」「私聊」两个 20×20 命中区替换角标，右键菜单保持不动
      //14.0.35.2 渲染条件由 hovered 扩为 hovered || focused；动作按钮自带焦点轮廓，键盘能看到自己停在哪
      const hoverActions = (hovered || focused) && !active
        ? h('div', { style: { display: 'flex', gap: 2, flex: '0 0 auto' } },
          props.onWake
            ? h('button', {
              type: 'button', title: (props.station === 'missing' ? '重建 ' + props.name + ' 的工位并上线' : '让 ' + props.name + ' 上线'),
              //14.0.43.2 符号按钮（↑/聊）读屏只会念符号，title 不是稳定名称，补 aria-label
              'aria-label': (props.station === 'missing' ? '重建 ' + props.name + ' 的工位并上线' : '让 ' + props.name + ' 上线'),
              onClick: (event) => { event.stopPropagation(); props.onWake() },
              //14.0.35.3 动作按钮同样需要焦点轮廓：它们是 Tab 序列上的独立焦点
              onFocus: focusRingOn, onBlur: focusRingOff,
              style: { all: 'unset', cursor: 'pointer', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, fontSize: 11, color: T.brand, background: T.overlay, border: '1px solid ' + T.border2 },
            }, '↑')
            : null,
          props.onOpen
            ? h('button', {
              type: 'button', title: '打开与 ' + props.name + ' 的会话',
              'aria-label': '打开与 ' + props.name + ' 的会话',
              onClick: (event) => { event.stopPropagation(); props.onOpen() },
              onFocus: focusRingOn, onBlur: focusRingOff,
              style: { all: 'unset', cursor: 'pointer', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, fontSize: 11, color: T.label1, background: T.overlay, border: '1px solid ' + T.border2 },
            }, '聊')
            : null)
        : null
      const badge = hoverActions || h('div', {
        style: { width: 42, flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
      },
        props.unread > 0
          ? h('span', {
            //14.0.34 未读角标是 18px 见方的胶囊，圆角 9 不属于 token 集合（8 已足够胶囊化），改 8
            style: { minWidth: 18, height: 18, padding: '0 5px', boxSizing: 'border-box', borderRadius: 8, background: T.brand, color: T.labelOnBrand, fontSize: 11, lineHeight: '18px', textAlign: 'center' },
          }, props.unread >= 99 ? '99+' : String(props.unread))
          : null,
        props.tasks > 0
          ? h('span', { style: { fontSize: 11, color: T.warn, lineHeight: '11px' } }, String(props.tasks))
          : null)
      return h('button', {
        type: 'button', onClick: props.onClick,
        //10.0.0 右键菜单：与企微一致的操作入口
        onContextMenu: props.onContextMenu || undefined,
        onMouseEnter: () => setHovered(true),
        onMouseLeave: () => setHovered(false),
        //14.0.35.4 行根 button 是可聚焦的：聚焦时亮轮廓并让动作按钮出现；焦点在行内子按钮间移动时不算离开
        onFocus: (event) => { setFocused(true); focusRingOn(event) },
        onBlur: (event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return
          setFocused(false)
          focusRingOff(event)
        },
        title: props.title || undefined,
        style: {
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
          //14.0.10 行间距 2px 呼吸：行内 padding 不动，行与行之间补 2px，长列表不至于糊成一整块
          padding: '8px 10px', borderRadius: 10, width: '100%', boxSizing: 'border-box', marginBottom: 2,
          background: active ? T.layer2 : 'transparent',
          borderLeft: props.pinned ? '2px solid ' + T.brand : '2px solid transparent',
        },
      },
        //10.0.1 头像右下角状态点：绿=在线待命，橙=工位缺失（可重建），灰=未绑定；让列表能看出谁活着、谁要修
        h('div', { style: { position: 'relative', flex: '0 0 auto' } },
          h(Avatar, { name: props.name, size: 36 }),
          (props.online === undefined && !props.station)
            ? null
            : h('span', {
              title: dot.title,
              style: {
                position: 'absolute', right: -1, bottom: -1, width: 10, height: 10,
                borderRadius: '50%', background: dot.color,
                border: '2px solid ' + T.layer1,
              },
            })),
        h('div', { style: { flex: 1, minWidth: 0 } },
          //14.0.47.1 未绑定组不再整组降透明度：整组 opacity 会连同头像、状态点、角标一起变淡，读起来像「整块不可用」，
          //          而实际语义只是「这批人还没绑工位」。改为只把姓名压成次级文字色，其余元素保持原对比度
          h('div', { style: { color: props.dim ? T.label2 : T.label1, fontSize: 13, fontWeight: 600, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.name),
          h('div', {
            style: {
              color: T.label2, fontSize: 11, lineHeight: 1.2, marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, (props.previewFrom || '') + (props.previewText || (props.online ? '在线待命，尚未对话' : '未对话')))),
        badge)
    }

    //10. 聊天区：顶部标题、中间气泡流、底部输入框
    function ChatPane(props) {
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [mentionQuery, setMentionQuery] = useState(null)
      const [showMembers, setShowMembers] = useState(false)
      //10.2.1 气泡右键菜单：局部状态，不依赖外层 StaffCenter
      const [bubbleMenu, setBubbleMenu] = useState(null)
      const listRef = useRef(null)
      const inputRef = useRef(null)
      //14.0.45.2 气泡菜单同样需要外部关闭：菜单挂在聊天区里，点空白处或滚动消息流都该收起（触屏/键盘场景下 onMouseLeave 不触发）
      const bubbleMenuRef = useRef(null)
      useEffect(() => {
        if (!bubbleMenu || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onPointerDown = (event) => {
          const node = bubbleMenuRef.current
          if (node && event && event.target && typeof node.contains === 'function' && node.contains(event.target)) return
          setBubbleMenu(null)
        }
        const onScroll = () => setBubbleMenu(null)
        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          if (typeof window.removeEventListener !== 'function') return
          window.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [bubbleMenu])
      const messages = props.messages || []
      const mentionables = props.mentionables || []
      //10.1 新消息到达时滚到底，符合聊天习惯
      useEffect(() => {
        const node = listRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [messages.length, props.title])
      //10.2 从文本里认出 @了谁：取第一个命中的成员名
      const detectMention = (value) => {
        for (const item of mentionables) {
          if (value.indexOf('@' + item.name) >= 0) return item.name
        }
        return null
      }
      const send = async () => {
        const value = text.trim()
        if (value === '' || busy) return
        setBusy(true)
        try {
          const sent = await props.onSend(value, detectMention(value))
          //16.2 只有成功才清空；失败时保留原文，用户可直接重试而不用重写一遍
          if (sent === false) return
          setText('')
          setMentionQuery(null)
        } catch (error) {
          props.onError(error.message)
        } finally {
          setBusy(false)
        }
      }
      const members = props.members || []
      //14.0.24 名册外成员：快照把 members 过滤成名册内的人，悬空名单单独给；这里只提示，绝不渲染成活人
      const dangling = Array.isArray(props.dangling) ? props.dangling : []
      const danglingText = danglingWarningOf(dangling)
      //14.0.25 警示条放在群头部下方：不依赖成员条展开，收起成员也看得见，数据问题不该藏在二级面板里
      const danglingBar = danglingText
        ? h('div', {
          title: '群成员里有不在名册中的名字，需人工修数据',
          style: {
            padding: '6px 16px', fontSize: 12, color: T.warn, borderBottom: '1px solid ' + T.border1,
            background: 'var(--dsw-alias-bg-layer-2)', display: 'flex', gap: 8, alignItems: 'center',
          },
        },
          h('span', { style: { flex: '0 0 auto', fontWeight: 600 } }, '!'),
          h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, danglingText))
        : null
      const header = h('div', {
        style: { padding: '12px 16px', borderBottom: '1px solid ' + T.border1, display: 'flex', alignItems: 'center', gap: 10 },
      },
        h(Avatar, { name: props.title, size: 32 }),
        h('div', {
          style: { flex: 1, minWidth: 0, cursor: props.onTitleClick ? 'pointer' : 'default' },
          onClick: props.onTitleClick || undefined,
          title: props.onTitleClick ? '查看员工档案' : undefined,
        },
          //14.0.41 长文本截断（审计 P2-9）：群名/成员名单/工作区完整路径会把标题行撑成三五行、把消息区往下顶。
          //        外层 flex 已有 minWidth:0，但文本节点自己不省略就换行；title 保留全文，悬停仍能读全
          h('div', {
            title: String(props.title || ''),
            style: { color: T.label1, fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, props.title),
          h('div', {
            title: props.subtitle ? String(props.subtitle) : undefined,
            style: { color: T.label2, fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, props.subtitle || '')),
        //10.4.1 按当前会话上线：群则拉起群成员，私聊则拉起该员工
        props.onWake
          ? h('button', {
            type: 'button',
            onClick: props.onWake,
            title: props.wakeTitle || '让本会话的员工上线',
            //14.0.48 header 胶囊统一 28 高命中区（审计 P3-13 / qa A1）：6 个胶囊都只有 4px 纵向 padding + 12px 字号，
            //          实际高约 24.8，鼠标点在边缘会漏。只补 minHeight 与 border-box，padding/字号/圆角一律不动；
            //          代价是头部整体长高约 3px，lead 已确认可接受
            style: { cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.labelOnBrand, background: T.brand, border: 'none', flex: '0 0 auto' },
          }, '上线')
          : null,
        //10.4.3 工作区：一个按钮完成绑定与换绑，未绑定时显示「设工作区」
        props.onWorkspace
          ? h('button', {
            type: 'button',
            onClick: props.onWorkspace,
            title: props.workspaceTitle || '绑定或换绑本群的工作区',
            //14.0.51 StaffBar 四个胶囊补 28 高命中区（审计 P3-18）：与 14.0.48 的 header 胶囊同口径，只加 minHeight + border-box，
            //          padding/字号/圆角/颜色一律不动；该行 flexWrap 已开，「成员」不会被挤到第二行
            style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label2, background: 'transparent', border: '1px solid ' + T.border2, flex: '0 0 auto' },
          }, props.workspaceLabel || '设工作区')
          : null,
        //10.4.2 跨天续会话：在群绑定的工作区新开一个会话，旧会话与历史消息原样保留
        props.onRotate
          ? h('button', {
            type: 'button',
            onClick: props.onRotate,
            title: props.rotateTitle || '在绑定的工作区新开一个会话继续',
            style: { cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.brand, background: 'transparent', border: '1px solid ' + T.brand, flex: '0 0 auto' },
          }, '新任务')
          : null,
        //13.10.2 一键上线：新建会话 + 拉起本群成员，二合一入口
        props.onOneClickOnline
          ? h('button', {
            type: 'button',
            onClick: props.onOneClickOnline,
            title: '在该群绑定的工作区新建一个会话，并把本群成员全部拉起',
            style: { cursor: 'pointer', fontSize: 12, padding: '4px 12px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.labelOnBrand, background: T.brand, border: '1px solid ' + T.brand, flex: '0 0 auto' },
          }, '一键上线')
          : null,
        members.length > 0
          ? h('button', {
            type: 'button',
            onClick: () => setShowMembers(!showMembers),
            title: '查看群成员',
            style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label2, background: 'transparent', border: '1px solid ' + T.border2, flex: '0 0 auto' },
          }, '成员 ' + members.length + (showMembers ? ' ▴' : ' ▾'))
          : null)
      //10.5 成员条：头像 + 名字 + 岗位 + 在线点 + 移出；末尾解散群
      const memberBar = showMembers && members.length > 0 ? h('div', {
        style: { padding: '8px 16px', borderBottom: '1px solid ' + T.border1, display: 'flex', flexWrap: 'wrap', gap: 8, background: T.layer1, alignItems: 'center' },
      },
        members.map((item) => {
          //14.0.11 成员条状态点：与列表行共用 stationDotOf 的三色与提示
          const memberDot = stationDotOf(item.station)
          return h('div', {
            key: item.name,
            onContextMenu: props.onMemberMenu ? (event) => { event.preventDefault(); props.onMemberMenu(item.name, event) } : undefined,
            style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 16, background: T.overlay, border: '1px solid ' + T.border1 },
          },
            h(Avatar, { name: item.name, size: 22 }),
            //14.0.11.1 「姓名 · 岗位」合成一行：岗位缺失就明说「未设岗位」，不留一段空白让人猜
            //14.0.41.1 成员 chip 限宽省略：岗位名很长时 chip 会把整行挤到换行（审计 P2-9 的 779）
            h('span', {
              title: item.name + ' · ' + (item.post || '未设岗位'),
              style: { fontSize: 12, color: T.label1, display: 'inline-block', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, item.name + ' · ' + (item.post || '未设岗位')),
            //14.0.11.2 状态点沿用三色口径；颜色之外 title 也写清处置，色弱用户同样能读懂
            h('span', {
              title: memberDot.title,
              style: { width: 6, height: 6, borderRadius: '50%', background: memberDot.color },
            }),
            props.onKick
              ? h('button', {
                type: 'button',
                onClick: () => props.onKick(item.name),
                title: '把 ' + item.name + ' 移出本群',
                //14.0.39.6 成员 chip 里的「移出」命中区原来只靠 11px 字形，紧贴 chip 边界，容易点到群里
                'aria-label': '把 ' + item.name + ' 移出本群',
                style: Object.assign({ all: 'unset', cursor: 'pointer', fontSize: 11, color: T.danger }, HIT),
              }, '移出')
              : null)
        }),
        props.onDeleteGroup
          ? h('button', {
            type: 'button',
            onClick: props.onDeleteGroup,
            title: '解散本群（不可恢复）',
            style: { marginLeft: 'auto', cursor: 'pointer', fontSize: 11, color: T.danger, background: 'transparent', border: '1px solid ' + T.danger, borderRadius: 12, padding: '3px 10px' },
          }, '解散此群')
          : null) : null
      const list = h('div', {
        ref: listRef,
        style: { flex: 1, overflowY: 'auto', padding: '16px 18px', minHeight: 0 },
      },
        props.hint ? h('div', { style: { fontSize: 11, color: T.label2, textAlign: 'center', padding: '4px 0 12px' } }, props.hint) : null,
        messages.length === 0
          ? h('div', { style: { color: T.label2, fontSize: 12, textAlign: 'center', paddingTop: 40 } }, '还没有消息，说第一句吧')
          : messages.map((message, index) => h(Bubble, {
            key: message.seq || index,
            sender: message.sender || message.from || '?',
            text: message.text,
            ts: message.ts,
            mine: message.mine,
            onContextMenu: (event) => {
              event.preventDefault()
              setBubbleMenu({
                x: Math.min(event.clientX, window.innerWidth - 190),
                y: Math.min(event.clientY, window.innerHeight - 170),
                message: message,
              })
            },
          })))
      //10.3 @ 选人：光标前有 @片段就替换它；没有片段（含空输入框）就在光标处直接插入
      const insertMention = (name) => {
        const node = inputRef.current
        const pos = node ? (node.selectionStart || 0) : text.length
        const head = text.slice(0, pos)
        const tail = text.slice(pos)
        const hasFragment = /@[^\s@]*$/.test(head)
        const replaced = hasFragment
          ? head.replace(/@[^\s@]*$/, '@' + name + ' ')
          : head + '@' + name + ' '
        const next = replaced + tail
        setText(next)
        setMentionQuery(null)
        requestAnimationFrame(() => {
          if (!node) return
          node.focus()
          const caret = replaced.length
          node.setSelectionRange(caret, caret)
        })
      }
      const candidates = mentionQuery === null ? [] : mentionables.filter((item) => item.name.indexOf(mentionQuery) >= 0)
      const mentionLayer = candidates.length > 0 ? h('div', {
        style: {
          position: 'absolute', bottom: 62, left: 18, right: 18, maxHeight: 180, overflowY: 'auto',
          background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,0.24)', zIndex: 10,
        },
      }, candidates.map((item) => h('button', {
        key: item.name, type: 'button',
        onClick: () => insertMention(item.name),
        style: {
          all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8,
          width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 13, color: T.label1,
        },
      },
        h('span', null, '@' + item.name),
        h('span', { style: { color: T.label2, fontSize: 11 } }, item.post || '')))) : null
      const composer = h('div', {
        style: { position: 'relative', display: 'flex', gap: 8, padding: '12px 18px', borderTop: '1px solid ' + T.border1, alignItems: 'center' },
      },
        mentionLayer,
        h('input', {
          ref: inputRef,
          value: text,
          placeholder: props.placeholder,
          //14.0.43 可访问名称（审计 P2 无障碍）：placeholder 输入后即消失、不是稳定名称，读屏只听得到「编辑框」
          'aria-label': props.placeholder || '输入消息',
          onChange: (event) => {
            const value = event.target.value
            setText(value)
            //10.4 检测光标前的 @片段；私聊没有可选成员时不弹层
            const pos = event.target.selectionStart || 0
            const match = /@([^\s@]*)$/.exec(value.slice(0, pos))
            setMentionQuery(match && mentionables.length > 0 ? match[1] : null)
          },
          onKeyDown: (event) => {
            //14.0.28 Esc 分层归属：@ 候选层先吞，草稿非空时也只吞不放；
            //        面板级监听认 preventDefault，否则按一下 Esc 就把员工中心和写了一半的指令一起清掉
            if (event.key === 'Escape' && mentionQuery !== null) { event.preventDefault(); setMentionQuery(null); return }
            if (event.key === 'Escape' && text !== '') { event.preventDefault(); return }
            //14.0.17 输入法合成态的回车（中文候选上屏）不得触发发送，否则半截文本会真实投递到私聊或群里且无法撤回；keyCode 229 兜旧版 Electron。Shift+Enter 保持换行，不发送
            if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent && event.nativeEvent.isComposing) && event.keyCode !== 229) send()
          },
          style: {
            flex: 1, padding: '8px 12px', fontSize: 13, color: T.label1,
            background: T.layer2, border: '1px solid ' + T.border2, borderRadius: 18, outline: 'none',
          },
        }),
        h('button', {
          type: 'button', onClick: send, disabled: busy,
          style: {
            cursor: busy ? 'default' : 'pointer', fontSize: 13, padding: '8px 16px', borderRadius: 18,
            color: T.labelOnBrand, background: T.brand, border: 'none', opacity: busy ? 0.6 : 1,
          },
        }, busy ? '…' : '发送'))
      //10.6 气泡右键菜单：复制内容、@此人（把名字填进输入框）
      const bubbleContextMenu = bubbleMenu
        ? h('div', {
          //14.0.45.4 容器挂 ref 供 14.0.45.2 判内外；role=menu 让读屏识别为一组动作而不是普通区块
          ref: bubbleMenuRef,
          role: 'menu',
          style: {
            position: 'fixed', left: bubbleMenu.x, top: bubbleMenu.y, zIndex: 9700,
            background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,0.28)', padding: 6, minWidth: 170,
            pointerEvents: 'auto',
          },
          onMouseLeave: () => setBubbleMenu(null),
        },
          h('div', { style: { fontSize: 11, color: T.label2, padding: '4px 10px 6px' } },
            bubbleMenu.message.sender || '消息'),
          h('button', {
            type: 'button',
            role: 'menuitem',
            onClick: () => {
              try { navigator.clipboard.writeText(String(bubbleMenu.message.text || '')) } catch (error) { /* 剪贴板不可用则忽略 */ }
              setBubbleMenu(null)
            },
            style: { all: 'unset', cursor: 'pointer', display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 13, borderRadius: 6, color: T.label1 },
          }, '复制内容'),
          bubbleMenu.message.mine
            ? null
            : h('button', {
              type: 'button',
              role: 'menuitem',
              onClick: () => { insertMention(bubbleMenu.message.sender); setBubbleMenu(null) },
              style: { all: 'unset', cursor: 'pointer', display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 12px', fontSize: 13, borderRadius: 6, color: T.label1 },
            }, '@' + (bubbleMenu.message.sender || '')))
        : null
      //14.0.26 组合顺序：头部 → 名册外警示 → 成员条 → 消息 → 输入区
      return h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 } }, header, danglingBar, memberBar, list, composer, bubbleContextMenu)
    }

    //11. 输入区状态带：可拖动、可关闭（只隐藏这条，不影响插件）
    function StaffBar(props) {
      //7.1 从会话作用域捕获当前会话 id，供所有动作请求带上
      if (props && props.sessionId) currentSessionId = props.sessionId
      const { snap, failed } = useSnapshot()
      const hidden = useBarHidden()
      const [pos, setPos] = useState(barStore.pos)
      const dragRef = useRef(null)
      //14.0.36 拖动与点击共用同一个按钮：浏览器在按下/松开同一元素时仍会补发 click，于是「把状态带挪个位置」
      //         松手常把员工中心整块弹出来。用位移阈值区分两者：累计位移 < 4px 交给 onClick，>= 4px 记标记吞掉那次 click
      const suppressClickRef = useRef(false)
      //11.1 拖动：按下记录起点与基准偏移，移动时更新，松开持久化到 localStorage
      const startDrag = (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        // 每次按下先清标记：万一上一轮松手没补发 click，也不该吞掉这一次真点击
        suppressClickRef.current = false
        dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: pos.x, baseY: pos.y, moved: false }
        const onMove = (moveEvent) => {
          const base = dragRef.current
          if (!base) return
          const dx = moveEvent.clientX - base.startX
          const dy = moveEvent.clientY - base.startY
          if (!base.moved && Math.abs(dx) + Math.abs(dy) >= 4) base.moved = true
          setPos({ x: base.baseX + dx, y: base.baseY + dy })
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          const moved = Boolean(dragRef.current && dragRef.current.moved)
          dragRef.current = null
          suppressClickRef.current = moved
          // 指针拖到按钮外松手时浏览器不补发 click，标记要自己过期，否则会吞掉下一次键盘回车触发的 click
          if (moved) window.setTimeout(() => { suppressClickRef.current = false }, 0)
          setPos((current) => {
            barStore.pos = current
            try { localStorage.setItem('dsh-staff-bar-pos', JSON.stringify(current)) } catch (error) { /* 忽略 */ }
            return current
          })
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }
      if (hidden) return null
      if (!snap) {
        //14.0.40.1 状态带也走 COPY：同一故障全产品同一种说法，不再一处「接口不可用」一处「接口刷新失败」
        //14.0.47.4 加载/故障态不再用 0.5 透明度：低对比度交给 T.label2，否则状态带在深浅两种底色上都发灰
        return h('div', { style: { fontSize: 12, color: T.label2, padding: '2px 4px' } },
          failed ? COPY.statusFailed : COPY.statusLoading)
      }
      const employees = Array.isArray(snap.employees) ? snap.employees : []
      const groups = Array.isArray(snap.groups) ? snap.groups : []
      const openTasks = employees.reduce((sum, item) => sum + (item.open ? item.open.length : 0), 0)
      //11.0.1 在线人数：状态带要能看出多少人在线，而不只是总数
      const onlineCount = employees.filter((item) => item.online).length
      return h('div', {
        //14.0.38.2 状态带不在面板内，自己也要一层捕获，否则 Tab 到「员工 N/M 在线」「×」时同样没有焦点反馈
        onFocusCapture: focusRingOn,
        onBlurCapture: focusRingOff,
        style: {
          position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2,
          transform: 'translate(' + pos.x + 'px, ' + pos.y + 'px)',
          padding: '2px 4px',
        },
      },
        h('button', {
          type: 'button',
          //14.0.36.1 拖动结束后那次补偿 click 直接吞掉（一次性），否则挪状态带就弹面板
          onClick: () => {
            if (suppressClickRef.current) { suppressClickRef.current = false; return }
            setPanelOpen(true)
          },
          onMouseDown: startDrag,
          title: '打开员工中心（按住可拖动）',
          'aria-label': '打开员工中心（按住可拖动）',
          style: {
            all: 'unset', cursor: 'grab', fontSize: 12,
            padding: '2px 8px', borderRadius: 6, border: '1px solid ' + T.border2, color: T.label2,
            userSelect: 'none',
          },
        }, '员工 ' + onlineCount + '/' + employees.length + ' 在线 · 待办 ' + openTasks + ' · 群 ' + groups.length + ' ▸'),
        //11.2 关闭：只隐藏状态带，插件与其他入口继续可用
        h('button', {
          type: 'button',
          onClick: () => setBarHidden(true),
          title: '隐藏状态带（不关闭插件，可在员工中心重新打开）',
          //14.0.39.4 命中区 + 可访问名称：读屏只念得出「×」，补 aria-label 说明这个符号做什么
          'aria-label': '隐藏员工状态带',
          //14.0.47.5 状态带两个按钮同样去掉 opacity：主按钮与 × 已经用 T.label2 表达「次要」，不需要再压一层
          style: Object.assign({ all: 'unset', cursor: 'pointer', fontSize: 11, color: T.label2, borderRadius: 4 }, HIT),
        }, '×'))
    }

    //12. 侧栏底部入口：打开员工中心（浮层全屏呈现）
    function StaffEntry() {
      return h('button', {
        type: 'button',
        title: '员工中心',
        'aria-label': '打开员工中心',
        onClick: () => setPanelOpen(true),
        //14.0.38.3 侧栏入口是叶子按钮，没有容器可挂捕获事件，直接挂自身
        onFocus: focusRingOn, onBlur: focusRingOff,
        style: { all: 'unset', cursor: 'pointer', fontSize: 12, color: T.label2, padding: '4px 8px', borderRadius: 6, border: '1px solid ' + T.border1 },
      }, '员工')
    }

    //13. 员工中心主面板
    //13.8 员工中心主体：浮层（overlay）与主面板（inline）共用同一份实现
    function StaffCenter(props) {
      const inline = Boolean(props && props.inline)
      const panelOpen = usePanelOpen()
      const open = inline || panelOpen
      const snapshot = useSnapshot()
      //13.0.9 选中的会话持久化：面板重新挂载后回到上次看的那一条，不再重置到空
      const [selected, setSelected] = useState(function () {
        try { return localStorage.getItem('dsh-staff-selected') || null } catch (error) { return null }
      })
      //13.0.10 选中变化即写盘；清空时移除键，避免残留失效 id
      useEffect(() => {
        try {
          if (selected) localStorage.setItem('dsh-staff-selected', selected)
          else localStorage.removeItem('dsh-staff-selected')
        } catch (error) { /* 存储不可用则忽略 */ }
      }, [selected])
      const [notice, setNotice] = useState(null)
      //14.0.21 成功提示 4 秒自动消失；依赖 notice 对象本身，新提示会重置计时器（不会叠加多条）
      useEffect(() => {
        if (!notice || noticeLevelOf(notice) !== 'ok') return undefined
        const timer = setTimeout(() => setNotice(null), NOTICE_OK_TTL_MS)
        return () => clearTimeout(timer)
      }, [notice])
      //14.0.22 切换选中对象即清空上一条操作提示：旧提示留着会让人以为它说的是新对象
      useEffect(() => {
        setNotice(null)
      }, [selected])
      const [showHire, setShowHire] = useState(false)
      const [showGroup, setShowGroup] = useState(false)
      const [hireName, setHireName] = useState('')
      const [hireTemplate, setHireTemplate] = useState('secretary')
      const [groupName, setGroupName] = useState('')
      const [groupMembers, setGroupMembers] = useState({})
      const [busy, setBusy] = useState(false)
      //14.3 三组折叠状态与检索词：群聊 / 在线员工 / 离线（离线默认收起），会话成员不单独成组、改为组内置顶；检索词只影响呈现，不改 snap
      //14.7.1 分组折叠初始值：待重建工位默认展开（老板要看见谁需要重建），未绑定工位默认收起
      const [collapsed, setCollapsed] = useState({ groups: false, online: false, missing: false, unbound: true })
      const [query, setQuery] = useState('')
      //13.0.2 档案页开关：点聊天区标题进入，点「← 返回」退出
      const [showDetail, setShowDetail] = useState(false)
      //13.0.4 右键菜单：记录坐标与菜单项，null 表示关闭
      const [menu, setMenu] = useState(null)
      //13.0.6 输入弹层：Electron 不支持 window.prompt，改用自绘框
      const [dialog, setDialog] = useState(null)
      //14.0.42.1 视口宽度进状态（审计 P1-3 补强）：原先左栏宽度在渲染时读一次 window.innerWidth，
      //          面板开着拖窗、分屏、改缩放后左栏仍是旧宽度，窄屏下聊天区继续被挤成竖条。
      //          这里订阅 resize 重算，卸载时移除监听；宿主没有 addEventListener 的桩环境直接跳过
      const [viewportWidth, setViewportWidth] = useState(readViewportWidth())
      //14.0.49 resize 合并用的帧句柄（审计 P3-16）：拖窗时 resize 一帧能触发多次，每次都 setState 会让整棵面板连续重排
      const resizeFrameRef = useRef(null)
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        //14.0.49.1 同一帧内的多次 resize 合并成一次重算；宿主没有 requestAnimationFrame（桩环境/旧 WebView）就直接算，功能不退化
        const onResize = () => {
          const apply = () => {
            resizeFrameRef.current = null
            setViewportWidth(readViewportWidth())
          }
          if (typeof window.requestAnimationFrame !== 'function') { apply(); return }
          if (resizeFrameRef.current !== null) return
          resizeFrameRef.current = window.requestAnimationFrame(apply)
        }
        window.addEventListener('resize', onResize)
        return () => {
          if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', onResize)
          //14.0.49.2 撤掉尚未执行的帧：面板已卸载还回调会把 setState 打到已销毁的组件上
          if (resizeFrameRef.current !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(resizeFrameRef.current)
          resizeFrameRef.current = null
        }
      }, [])
      //14.0.45 菜单容器引用：外部关闭时要判断点击是否落在菜单内部，菜单项自己的 onClick 负责关闭
      const menuRef = useRef(null)
      //14.0.44 二次确认状态：破坏性动作统一走自绘确认层（见 14.0.44.2），null 表示当前没有待确认动作
      const [confirmState, setConfirmState] = useState(null)
      //13.0.7 打开输入弹层：title 标题、value 初值、onConfirm 拿到输入后回调
      const openDialog = (title, value, onConfirm) => {
        setDialog({ title, value: value == null ? '' : String(value), onConfirm })
      }
      //15.1 指令菜单指定目标：面板已挂载时立即切换，否则挂载时消费暂存值（暂存与通知见 15.2/15.3）
      //15.1.1 切换后退出档案页，直接显示该会话的聊天区
      useEffect(() => {
        const applyTarget = (key) => {
          if (!key) return
          staffTargetStore.pending = null
          setSelected(key)
          setShowDetail(false)
        }
        staffTargetStore.listeners.add(applyTarget)
        if (staffTargetStore.pending) applyTarget(staffTargetStore.pending)
        return () => { staffTargetStore.listeners.delete(applyTarget) }
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          //14.0.28.1 ESC 是「退出最上面一层」，不是「一键清空员工中心」：输入框/弹层已处理过的放行，
          //          右键菜单与弹层只关自己那一层，剩下的才轮到面板
          if (event.defaultPrevented) return
          //14.0.44.4 ESC 分层（审计 task-41）：一次只关最上面一层——确认层 → 输入弹层 → 右键菜单 → 面板本身；
          //          关掉一层立即 return。否则「菜单 + 确认层」同开时按 Esc 会把两层一起清掉，
          //          注释写的「退出最上面一层」和实现就又是两回事
          if (confirmState) { setConfirmState(null); return }
          if (dialog) { setDialog(null); return }
          if (menu) { setMenu(null); return }
          //13.8.1 主面板模式按 ESC 回到对话页；浮层模式按 ESC 关闭弹层
          if (inline) {
            if (!showConversationPanel()) setPanelOpen(false)
          } else {
            setPanelOpen(false)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, inline, dialog, menu, confirmState])
      //14.0.45.1 菜单外部关闭（审计 P2-10）：原来的 onMouseLeave 只在鼠标滑出菜单时才收起——触屏没有 hover 语义，
      //          键盘打开后也无从收起，菜单会一直浮着。打开时在 window 上挂 pointerdown 与 scroll（都用捕获阶段，
      //          列表内部滚动也收得到），点到菜单外或滚动即关；用 14.0.45 的 ref 排除「点在菜单自己身上」
      useEffect(() => {
        if (!menu || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onPointerDown = (event) => {
          const node = menuRef.current
          if (node && event && event.target && typeof node.contains === 'function' && node.contains(event.target)) return
          setMenu(null)
        }
        const onScroll = () => setMenu(null)
        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          if (typeof window.removeEventListener !== 'function') return
          window.removeEventListener('pointerdown', onPointerDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [menu])

      //14.0.44.1 统一二次确认入口：破坏性动作一律先过这里，由 14.0.44.2 的确认层渲染。
      //          降级分支只保留这一处 window.confirm 判定：宿主完全没有 confirm 能力（桩环境/极简 WebView）时
      //          弹不出任何窗口，此时直接执行 onOk，避免动作被永久卡死。这是降级，不是第二套确认范式
      const confirmAsk = (options) => {
        const request = options || {}
        const runOk = () => { if (typeof request.onOk === 'function') request.onOk() }
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') { runOk(); return }
        setConfirmState({
          title: request.title || '确认操作',
          text: request.text || '',
          confirmText: request.confirmText || '确定',
          danger: Boolean(request.danger),
          onOk: request.onOk,
        })
      }
      //14.0.50 确认层焦点管理（审计 P3-19）：只挂 autoFocus 在宿主与桩渲染里都可能被忽略，且关闭后焦点掉回 body，
      //          键盘用户下一次 Tab 又从页面顶部重新找。三条一起补：打开聚焦「取消」、卡片内 Tab 自循环、关闭还回来源
      const confirmCardRef = useRef(null)
      const confirmCancelRef = useRef(null)
      const confirmOkRef = useRef(null)
      const confirmReturnFocusRef = useRef(null)
      //14.0.50.1 焦点操作统一守卫：ref 可能为 null（桩渲染不建真实 DOM）、focus 也可能不被支持，任何一条都不许抛错影响确认动作
      const safeFocus = (node) => {
        if (!node || typeof node.focus !== 'function') return
        try { node.focus() } catch (error) { /* 无焦点能力的环境直接跳过，确认/取消本身照常 */ }
      }
      //14.0.50.2 打开时记住来源并聚焦「取消」（破坏性动作默认不给「确定」，避免回车误触）；还焦点写在 cleanup 里，
      //          这样 Esc / 点遮罩 / 点取消 / 点确定四条路径自然共用同一收尾，不用各写一遍
      useEffect(() => {
        if (!confirmState) return undefined
        if (typeof document !== 'undefined' && document) confirmReturnFocusRef.current = document.activeElement || null
        safeFocus(confirmCancelRef.current || confirmCardRef.current)
        return () => {
          const origin = confirmReturnFocusRef.current
          confirmReturnFocusRef.current = null
          safeFocus(origin)
        }
      }, [confirmState])
      //14.0.50.3 关闭收口：清状态本身在调用点完成（Esc/遮罩/取消都是纯关闭，不跑动作），焦点由 14.0.50.2 的 cleanup
      //          统一还回来源；这里只补「确定」路径的动作执行——先清状态再跑 onOk，避免异步动作里再点一次重复提交
      const closeConfirm = (options) => {
        const next = confirmState
        setConfirmState(null)
        if (!options || !options.runOk) return
        if (next && typeof next.onOk === 'function') next.onOk()
      }
      //14.0.50.4 卡片内 Tab 自循环：只在「取消 / 确定」两个按钮间轮转，Shift+Tab 反向；取不到可聚焦节点时直接放行，
      //          不用 preventDefault 把键盘锁死在卡片里
      const trapConfirmTab = (event) => {
        const focusables = [confirmCancelRef.current, confirmOkRef.current].filter((node) => node && typeof node.focus === 'function')
        if (focusables.length === 0) return
        event.preventDefault()
        const active = typeof document !== 'undefined' && document ? document.activeElement : null
        const index = focusables.indexOf(active)
        const step = event.shiftKey ? -1 : 1
        const nextIndex = index < 0
          ? (event.shiftKey ? focusables.length - 1 : 0)
          : (index + step + focusables.length) % focusables.length
        safeFocus(focusables[nextIndex])
      }
      if (!open) return null

      const snap = snapshot.snap
      const employees = snap && Array.isArray(snap.employees) ? snap.employees : []
      const groups = snap && Array.isArray(snap.groups) ? snap.groups : []
      const conversations = (snap && snap.conversations) || {}
      const memberToName = {}
      for (const item of employees) if (item.member) memberToName[item.member] = item.name
      //14.0.6 三态区分：加载中给骨架、接口失败给重试、真的空数据才说「还没有会话」
      //        必须定义在检索框之前：检索框的 disabled 与 placeholder 依赖它，放到后面会踩 const 的 TDZ
      const loadingFirst = snap === null && !snapshot.failed
      const snapshotFailed = Boolean(snapshot.failed) && snap === null
      //17.8.11.3 陈旧态：有旧快照但最近一次刷新失败。既不能清空列表（用户还在用这批数据），
      //          也不能像以前那样静默——必须明确告知「数据可能已过期」，并给一次性刷新入口
      const snapshotStale = Boolean(snapshot.failed) && snap !== null

      //13.1 动作执行：统一提示与刷新
      const run = async (label, action, payload) => {
        setBusy(true)
        try {
          const result = await callAction(action, payload)
          //13.1.1 上线动作给人数摘要，比一句「成功」有用
          if (action === 'wake' && result && Array.isArray(result.results)) {
            const fresh = result.results.filter((item) => item.reason === '已上线').length
            const online = result.results.filter((item) => item.reason === '已在线').length
            const bad = result.results.filter((item) => !item.ok)
            setNotice({
              ok: bad.length === 0,
              //14.0.3 部分成功不是失败：全失败才红，有成功有人失败用 warn
              level: bad.length === 0 ? 'ok' : (bad.length < result.results.length ? 'warn' : 'error'),
              text: '上线完成：新上线 ' + fresh + ' 人，已在线 ' + online + ' 人' + (bad.length ? '，失败 ' + bad.length + ' 人（' + bad.map((item) => item.name + ':' + item.reason).join('；') + '）' : ''),
            })
          } else {
            setNotice({ ok: true, text: label + '成功' })
          }
          await snapshot.reload()
          //16.1 把执行结果交回调用方：发送类动作只在真正成功后清空输入，失败要保留草稿（P0-9：失败仍清空导致重复发送与重复计费）
          return true
        } catch (error) {
          setNotice({ ok: false, text: label + '失败：' + error.message })
          return false
        } finally {
          setBusy(false)
        }
      }

      //13.2 会话模型：kind='dm' 指员工，kind='group' 指群
      const activeKey = selected || (employees[0] ? 'dm:' + employees[0].name : (groups[0] ? 'group:' + groups[0].id : null))
      const activeDm = activeKey && activeKey.indexOf('dm:') === 0 ? activeKey.slice(3) : null
      const activeGroup = activeKey && activeKey.indexOf('group:') === 0 ? groups.find((g) => g.id === activeKey.slice(6)) : null
      const activeEmployee = activeDm ? employees.find((item) => item.name === activeDm) : null

      //13.3 私聊消息：我方右、对方左；员工回复经 Lead 转述后才会有
      const dmMessages = (activeDm ? (conversations[activeDm] || []) : []).map((message) => ({
        seq: message.seq,
        sender: message.from === 'user' ? '我' : (memberToName[message.from] || message.from),
        text: message.text,
        ts: message.ts,
        mine: message.from === 'user',
      }))

      //13.4 群消息：lead 与 user 视为我方，员工名映射为中文名
      const groupMessages = activeGroup
        ? (activeGroup.messages || []).map((message) => {
          const mine = message.from === 'lead' || message.from === 'user'
          return {
            seq: message.seq,
            sender: mine ? '我' : (memberToName[message.from] || message.from),
            text: message.text,
            ts: message.ts,
            mine,
          }
        })
        : []

      const header = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid ' + T.border1 },
      },
        //14.0.32 面板标题字号 15 不在设计 token 的字号集合内；同级标题（状态带标题、员工档案）都是 14，
        //         16 会压过详情页姓名，故统一到 14 而不是往上抬
        h('span', { style: { color: T.label1, fontSize: 14, fontWeight: 600 } }, '员工中心'),
        //13.5.0 恢复入口：状态带被隐藏后从这里重新打开
        h('button', {
          type: 'button',
          onClick: () => { setBarHidden(false); setPanelOpen(false) },
          title: '在输入框上方重新显示员工状态带',
          'aria-label': '在输入框上方重新显示员工状态带',
          style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label2, background: 'transparent', border: '1px solid ' + T.border1 },
        }, '显示状态带'),
        h('button', {
          type: 'button', disabled: busy,
          onClick: () => run('全部员工上线', 'wake', {}),
          title: '把名册中所有未在线的员工挂到当前会话（人少时再用，平时建议在会话里按需上线）',
          'aria-label': '把名册中所有未在线的员工上线',
          style: { cursor: busy ? 'default' : 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label2, background: 'transparent', border: '1px solid ' + T.border1, opacity: busy ? 0.6 : 1 },
        }, busy ? '…' : '全部上线'),
        //13.9.0 自检：把「面板认为自己在哪个会话」与「该会话实际有几个员工」当场显示出来
        h('button', {
          type: 'button',
          title: '检查面板当前绑定的会话与该会话的员工数',
          'aria-label': '检查面板当前绑定的会话与该会话的员工数',
          onClick: async () => {
            try {
              const result = await callAction('whoami', {})
              const claimed = result && result.claimedSessionId ? String(result.claimedSessionId).slice(-8) : '未传'
              const members = result && Array.isArray(result.membersOfClaimed) ? result.membersOfClaimed : []
              //14.0.5.1 warn/off 模式下服务端只回数量不回名字（枚举面收敛，index.js //22.7.10.1），
              //          所以人数优先用 memberCount，名字有就附上、没有不显示「无」
              const count = result && Number.isInteger(result.memberCount) ? result.memberCount : members.length
              const brief = members.slice(0, 4).join('，')
              setNotice({
                ok: true,
                //14.0.4 自检结论为「0 人」时是诊断信号，不该显示成绿色成功
                level: count > 0 ? 'ok' : 'warn',
                text: '自检：面板会话 …' + claimed + '｜该会话员工 ' + count + ' 人' + (brief ? '｜' + brief : ''),
              })
            } catch (error) {
              setNotice({ ok: false, text: '自检失败：' + (error instanceof Error ? error.message : String(error)) })
            }
          },
          style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label2, background: 'transparent', border: '1px solid ' + T.border1 },
        }, '自检'),
        h('button', { type: 'button', onClick: () => { setShowHire(!showHire); setShowGroup(false) }, style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label1, background: 'transparent', border: '1px solid ' + T.border2 } }, '+ 员工'),
        h('button', { type: 'button', onClick: () => { setShowGroup(!showGroup); setShowHire(false) }, style: { cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 14, minHeight: 28, boxSizing: 'border-box', color: T.label1, background: 'transparent', border: '1px solid ' + T.border2 } }, '+ 群'),
        h('button', {
          type: 'button',
          onClick: () => {
            //13.8.2 主面板模式返回对话页；浮层模式关闭弹层
            if (inline) {
              if (!showConversationPanel()) setPanelOpen(false)
            } else {
              setPanelOpen(false)
            }
          },
          //14.0.39.5 浮层里这里是「×」、主面板里是「返回对话」，同一按钮两种语义，aria-label 跟着变
          'aria-label': inline ? '返回对话' : '关闭员工中心',
          style: Object.assign({ all: 'unset', cursor: 'pointer', marginLeft: 'auto', color: T.label2, fontSize: inline ? 12 : 18 }, HIT),
        }, inline ? '返回对话' : '×'))

      const hireForm = showHire ? h('div', {
        style: { padding: 10, margin: '8px', borderRadius: 10, background: T.layer2, border: '1px solid ' + T.border1 },
      },
        h('input', {
          value: hireName, onChange: (e) => setHireName(e.target.value), placeholder: '新员工姓名',
          'aria-label': '新员工姓名',
          style: { width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 12, color: T.label1, background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 8, outline: 'none' },
        }),
        h('select', {
          value: hireTemplate, onChange: (e) => setHireTemplate(e.target.value),
          'aria-label': '岗位模板',
          style: { width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '6px 10px', fontSize: 12, color: T.label1, background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 8 },
        },
          h('option', { value: 'secretary' }, '首席执行秘书'),
          h('option', { value: 'researcher' }, '研究助理'),
          h('option', { value: 'engineer' }, '工程师'),
          h('option', { value: 'tester' }, '测试负责人'),
          h('option', { value: 'product' }, '产品经理'),
          h('option', { value: 'ops' }, '运维 / SRE')),
        h('button', {
          type: 'button', disabled: busy,
          onClick: async () => {
            if (hireName.trim() === '') { setNotice({ ok: false, text: '姓名不能为空' }); return }
            await run('招募 ' + hireName, 'hire', { name: hireName.trim(), template: hireTemplate })
            setHireName(''); setShowHire(false)
          },
          style: { marginTop: 8, cursor: 'pointer', fontSize: 12, padding: '6px 12px', borderRadius: 8, color: T.labelOnBrand, background: T.brand, border: 'none', width: '100%' },
        }, busy ? '处理中…' : '确认招募')) : null

      const groupForm = showGroup ? h('div', {
        style: { padding: 10, margin: '8px', borderRadius: 10, background: T.layer2, border: '1px solid ' + T.border1 },
      },
        h('input', {
          value: groupName, onChange: (e) => setGroupName(e.target.value), placeholder: '群名称',
          'aria-label': '群名称',
          style: { width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 12, color: T.label1, background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 8, outline: 'none' },
        }),
        //14.0.29.2 文案与后端 2–8 对齐：写 2–6 会让用户以为 7 人建不了群，契约漂移就是这么来的
        h('div', { style: { fontSize: 11, color: T.label2, margin: '8px 0 4px' } }, '选择成员（2–8 人）'),
        //14.0.41.2 勾选清单限高内部滚动（审计 P2-9）：员工一多「创建群」按钮被顶出可视区，且整块不能滚
        h('div', { style: { maxHeight: 200, overflowY: 'auto' } },
          employees.map((item) => h('label', {
            key: item.name,
            style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.label1, padding: '2px 0' },
          },
            h('input', {
              type: 'checkbox', checked: Boolean(groupMembers[item.name]),
              //14.0.29.1 到上限就禁掉未勾选项：让「不能再选」在点击前成立，而不是提交后等后端报错
              disabled: Object.keys(groupMembers).filter((key) => groupMembers[key]).length >= GROUP_MEMBER_LIMIT && !groupMembers[item.name],
              onChange: (e) => setGroupMembers(Object.assign({}, groupMembers, { [item.name]: e.target.checked })),
            }),
            h('span', null, item.name)))),
        h('button', {
          type: 'button', disabled: busy,
          onClick: async () => {
            const members = Object.keys(groupMembers).filter((key) => groupMembers[key])
            if (groupName.trim() === '') { setNotice({ ok: false, text: '群名不能为空' }); return }
            if (members.length < 2) { setNotice({ ok: false, text: '至少选 2 名成员' }); return }
            //14.0.29.3 前端补齐上限拦截：与后端同一条规则报同一个数，避免「界面说 6 人、后端说 8 人」
            if (members.length > GROUP_MEMBER_LIMIT) { setNotice({ ok: false, text: '群成员最多 ' + GROUP_MEMBER_LIMIT + ' 人，当前已选 ' + members.length + ' 人' }); return }
            await run('建群 ' + groupName, 'group-create', { name: groupName.trim(), members: members })
            setGroupName(''); setGroupMembers({}); setShowGroup(false)
          },
          style: { marginTop: 8, cursor: 'pointer', fontSize: 12, padding: '6px 12px', borderRadius: 8, color: T.labelOnBrand, background: T.brand, border: 'none', width: '100%' },
        }, busy ? '处理中…' : '创建群')) : null

      //14.4 排序键：未读降序 → 待办阻塞 → 在线 → 最后消息时间降序 → 姓名；先建纯数据行再排序，避免边 map 边排
      const compareRows = (a, b) => {
        if (b.unread !== a.unread) return b.unread - a.unread
        const taskA = a.tasks > 0 ? 1 : 0
        const taskB = b.tasks > 0 ? 1 : 0
        if (taskB !== taskA) return taskB - taskA
        const onlineA = a.online ? 1 : 0
        const onlineB = b.online ? 1 : 0
        if (onlineB !== onlineA) return onlineB - onlineA
        if (b.lastTs !== a.lastTs) return b.lastTs - a.lastTs
        return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN')
      }
      const buildRow = (kind, key, name, online, messages, tasks, post, station) => {
        // 未读按 seq 全量重算，摘要与发送方取最后一条消息；不新增请求、不写入未读数本身
        const last = messages.length > 0 ? messages[messages.length - 1] : null
        const fromMe = Boolean(last && (last.from === 'user' || last.from === 'lead'))
        return {
          kind, key, name, online, station, tasks, post: post || '', messages,
          //14.0.30 未读只认显式选中：activeKey 在未点开任何会话时会兜底成第一个员工，
        //        拿它判定「正在看」会让新消息角标恒为 0，漏看比多一个角标严重得多
        unread: unreadOf(key, messages, selected),
          lastTs: last && last.ts ? last.ts : 0,
          previewText: last ? String(last.text || '').slice(0, 24) : '',
          previewFrom: last && kind === 'dm' ? (fromMe ? '我：' : 'TA：') : '',
        }
      }
      //14.5 组内置顶：当前会话成员从已有数据推导（群用 activeGroup.members，私聊用 activeKey），零接口、零新增请求
      const pinnedNames = {}
      if (activeGroup && Array.isArray(activeGroup.members)) {
        for (const name of activeGroup.members) pinnedNames[name] = true
      }
      if (activeDm) pinnedNames[activeDm] = true
      const sortRows = (rows) => rows.slice().sort((a, b) => {
        const pinA = pinnedNames[a.name] ? 1 : 0
        const pinB = pinnedNames[b.name] ? 1 : 0
        if (pinA !== pinB) return pinB - pinA
        if (pinA === 1) return b.lastTs - a.lastTs
        return compareRows(a, b)
      })
      //14.6 进入会话的唯一出口：先前进未读位点再切换选中，点击与右键进入都走这里，保证位点只前进不回退
      const openConversation = (key, messages, detail) => {
        writeSeenPoint(key, messages || [])
        setSelected(key)
        setShowDetail(Boolean(detail))
      }
      const employeeRows = employees.map((item) => buildRow('dm', 'dm:' + item.name, item.name, item.online, conversations[item.name] || [], (item.open || []).length, item.post, employeeStationOf(item)))
      const groupRows = groups.map((group) => buildRow('group', 'group:' + group.id, group.name, undefined, group.messages || [], 0, ''))
      const matchQuery = (row) => query === '' || row.name.indexOf(query) >= 0 || row.post.indexOf(query) >= 0
      //14.6.2 分组按工位三态切分：在线 / 待重建（工位缺失） / 未绑定；三者处置不同，不能混成一个「离线」
      const onlineRows = sortRows(employeeRows.filter((row) => row.station === 'online' && matchQuery(row)))
      const missingRows = sortRows(employeeRows.filter((row) => row.station === 'missing' && matchQuery(row)))
      const unboundRows = sortRows(employeeRows.filter((row) => row.station === 'unbound' && matchQuery(row)))
      const visibleGroups = sortRows(groupRows.filter(matchQuery))
      //14.7 三段渲染：群聊 → 在线员工 → 离线（默认折叠）；置顶项带 2px brand 竖条，检索与折叠只影响呈现
      //14.0.47.2 未绑定组用 dim 标记「次级」：由行组件把姓名降为 T.label2，不再在容器上糊一层 opacity
      const renderRow = (row, dim) => h(ConversationItem, {
        key: row.key,
        dim: Boolean(dim),
        name: row.name,
        pinned: Boolean(pinnedNames[row.name]),
        online: row.online,
        station: row.station,
        unread: row.unread,
        tasks: row.tasks,
        previewText: row.previewText,
        previewFrom: row.previewFrom,
        active: activeKey === row.key,
        onClick: () => openConversation(row.key, row.messages, false),
        onOpen: () => openConversation(row.key, row.messages, false),
        onWake: row.kind === 'dm'
          ? () => run(row.name + ' 上线', 'wake', { scope: { kind: 'employee', name: row.name } })
          : () => run('拉起群内成员', 'wake', { scope: { kind: 'group', id: row.key.slice(6) } }),
        onContextMenu: (event) => {
          event.preventDefault()
          //13.5.2 员工右键四项：发送消息 / 查看资料 / 上线 / 解雇；离职时清掉指向该员工的选中会话
          if (row.kind === 'dm') {
            setMenu({
              x: Math.min(event.clientX, window.innerWidth - 180),
              y: Math.min(event.clientY, window.innerHeight - 200),
              title: row.name,
              items: [
                { label: '发送消息', action: () => openConversation(row.key, row.messages, false) },
                { label: '查看资料', action: () => openConversation(row.key, row.messages, true) },
                {
                  label: '上线此人',
                  action: () => run(row.name + ' 上线', 'wake', { scope: { kind: 'employee', name: row.name } }),
                },
                {
                  label: '让此人离职',
                  danger: true,
                  //14.0.44.5 六个破坏性动作统一走 confirmAsk：action 只负责描述，真正执行放进 onOk
                  action: () => confirmAsk({
                    title: '让「' + row.name + '」离职？',
                    text: '档案与历史任务会保留，但不再计入在职员工。',
                    confirmText: '让其离职',
                    danger: true,
                    onOk: () => {
                      run('解雇 ' + row.name, 'staff-fire', { name: row.name })
                      if (row.key === activeKey) setSelected(null)
                    },
                  }),
                },
              ],
            })
            return
          }
          //13.5.3 群右键四项：进入群聊 / 拉起群成员 / 工作区 / 解散群
          const group = groups.find((item) => item.id === row.key.slice(6))
          if (!group) return
          setMenu({
            x: Math.min(event.clientX, window.innerWidth - 180),
            y: Math.min(event.clientY, window.innerHeight - 200),
            title: group.name,
            items: [
              { label: '进入群聊', action: () => openConversation(row.key, row.messages, false) },
              {
                label: '拉起群成员（' + (group.members || []).length + ' 人）',
                action: () => run('拉起群内成员', 'wake', { scope: { kind: 'group', id: group.id } }),
              },
              {
                //13.5.4 工作区设置：与标题栏按钮同一能力，右键也能改
                label: group.workspace ? '换绑工作区（当前 ' + group.workspace + '）' : '设置工作区',
                action: () => {
                  openDialog(
                    '输入「' + group.name + '」的工作区绝对路径（例如 E:/DSH）；留空并确定表示解除绑定。',
                    group.workspace || '',
                    (input) => {
                      const next = String(input == null ? '' : input).trim()
                      run(next === '' ? '解除工作区' : '绑定工作区', 'group-update', {
                        groupId: group.id,
                        workspace: next,
                      })
                    },
                  )
                },
              },
              {
                label: '解散此群',
                danger: true,
                action: () => confirmAsk({
                  title: '解散「' + group.name + '」？',
                  text: '群消息会一并删除，不可恢复。',
                  confirmText: '解散',
                  danger: true,
                  onOk: () => {
                    run('解散群', 'group-delete', { groupId: group.id })
                    setSelected(null)
                  },
                }),
              },
            ],
          })
        },
      })

      //13.5.1 分组标题：可点击折叠；群在前、员工在后，避免人多之后混成一堆
      const sectionHeader = (key, title, count) => h('button', {
        type: 'button',
        onClick: () => setCollapsed(Object.assign({}, collapsed, { [key]: !collapsed[key] })),
        title: collapsed[key] ? '展开' : '收起',
        style: {
          all: 'unset', cursor: 'pointer', width: '100%', boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: 6,
          //14.0.12 分组标题上下各补 2px 呼吸：三组之间不贴死，扫一眼就能看出分组边界
          //14.0.47.3 标题本来就是次级文字色（T.label2），再叠 0.85 透明度只会更糊；去掉 opacity，层级靠颜色表达
          fontSize: 11, color: T.label2, padding: '12px 8px 6px', letterSpacing: 0.4,
        },
      },
        h('span', { style: { fontSize: 9 } }, collapsed[key] ? '▸' : '▾'),
        h('span', null, title + ' · ' + count))
      //14.8 左栏检索与三段渲染：检索只过滤呈现；群聊 → 在线员工 → 离线（默认折叠、整组降透明度）；空态按「无数据」与「无匹配」分开
      const searchBar = h('input', {
        type: 'search', value: query,
        //14.0.7 首屏未就绪时禁用检索：对着骨架屏输入没有意义，反而让人以为过滤失效
        disabled: loadingFirst,
        onChange: (event) => setQuery(event.target.value),
        placeholder: loadingFirst ? '加载中…' : '搜索员工 / 岗位 / 群名',
        //14.0.43.1 检索框同样补名称：type=search 在部分读屏里只报「搜索」，不报搜什么
        'aria-label': '搜索员工 / 岗位 / 群名',
        style: {
          width: '100%', height: 40, boxSizing: 'border-box', padding: '0 10px',
          fontSize: 11, color: T.label1, background: T.layer2,
          border: '1px solid ' + T.border1, borderRadius: 8, outline: 'none',
        },
      })
      const hasAnyConversation = employees.length > 0 || groups.length > 0
      //14.0.46 空态文案统一口径（审计 P2-7）：句末不带句号，有下一步就给动作、没有动作就说清状态。
      //          左栏保留「还没有会话」前缀（polish 用例按这个词判定空态），后半句直接写成可执行动作
      const emptyText = loadingFirst || snapshotFailed
        ? ''
        : (!hasAnyConversation
          ? '还没有会话，点「+ 员工」或「+ 群」新建'
          : (query !== '' ? '没有匹配的会话' : ''))
      //14.0.37 窄窗口：左栏写死 280 时，320px 视口下聊天区只剩约 20px，标题/输入框全被挤成竖条。
      //         改成可收缩的 flex 基准——常规 280，视口 < 640 时降 200；minWidth 0 让窄容器能继续让位给右栏
      //14.0.42.2 宽度不再就地读一次：取 14.0.42.1 的响应式状态，拖窗后左栏跟着重排；
      //          状态缺失（桩环境/旧快照）时回退 1280，不让 undefined 传染到宽度计算
      const safeViewportWidth = Number(viewportWidth) > 0 ? Number(viewportWidth) : 1280
      const leftWidth = safeViewportWidth < 640 ? 200 : 280
      const left = h('div', {
        style: { flex: '0 0 ' + leftWidth + 'px', minWidth: 0, borderRight: '1px solid ' + T.border1, display: 'flex', flexDirection: 'column', minHeight: 0 },
      },
        hireForm,
        groupForm,
        h('div', { style: { flex: 1, overflowY: 'auto', padding: 8, minHeight: 0 } },
          searchBar,
          loadingFirst ? h(SkeletonList, { rows: 5 }) : null,
          snapshotFailed
            ? h('div', { style: { margin: '4px 2px 8px', padding: '8px 10px', fontSize: 12, color: T.danger, border: '1px solid ' + T.border1, borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 } },
              //14.0.40.2 标题+限定语拆成两段常量拼接：故障名与「正在自动重试」各自单一来源，改动不再漏改一处
              h('span', { style: { flex: 1, minWidth: 0 } }, COPY.apiDown + '，' + COPY.apiDownNote),
              //14.0.39.2 命中区：原来 padding '0 2px' 高约 22px，这里换 HIT（28×28），文案仍走 COPY.retry
              h('button', {
                type: 'button', onClick: () => snapshot.reload(),
                'aria-label': COPY.retry,
                style: Object.assign({ all: 'unset', cursor: 'pointer', fontSize: 12, color: T.brand }, HIT),
              }, COPY.retry))
            : null,
          emptyText ? h('div', { style: { color: T.label2, fontSize: 12, padding: 12 } }, emptyText) : null,
          visibleGroups.length > 0 ? sectionHeader('groups', '群聊', visibleGroups.length) : null,
          collapsed.groups ? null : visibleGroups.map(renderRow),
          onlineRows.length > 0 ? sectionHeader('online', '在线员工', onlineRows.length) : null,
          collapsed.online ? null : onlineRows.map(renderRow),
          //14.8.1 待重建工位：teammate 已不在任何会话，发消息会自动重建，界面提前告知而不是让人以为只是离线
          missingRows.length > 0 ? sectionHeader('missing', '待重建工位', missingRows.length) : null,
          collapsed.missing ? null : missingRows.map(renderRow),
          unboundRows.length > 0 ? sectionHeader('unbound', '未绑定工位', unboundRows.length) : null,
          unboundRows.length > 0 && !collapsed.unbound
            ? h('div', null, unboundRows.map((row) => renderRow(row, true)))
            : null))

      //13.0.0 档案页工位三态文案：每态给一句可执行的话，别让老板自己猜「离线」要不要修
      const activeStation = activeEmployee ? employeeStationOf(activeEmployee) : null
      const STATION_TEXT = { online: '在线待命', missing: '工位缺失（发消息会自动重建）', unbound: '未绑定工位' }
      const stationText = STATION_TEXT[activeStation] || ''
      //13.0.1 员工档案页：点聊天区标题打开，展示岗位说明书、任务、所在群
      //14.0.13 惰性构造：只有「档案页可见 + 员工在快照里」才构造详情树。
      //       即使详情里某个子组件出问题，也不会在聊天态就提前执行、把整个员工中心一起带走
      const detailPanel = (showDetail && activeEmployee) ? h('div', {
        style: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 },
      },
        h('div', {
          style: { padding: '12px 16px', borderBottom: '1px solid ' + T.border1, display: 'flex', alignItems: 'center', gap: 12 },
        },
          h('button', {
            type: 'button', onClick: () => setShowDetail(false),
            style: { all: 'unset', cursor: 'pointer', color: T.label2, fontSize: 13 },
          }, '← 返回'),
          h('span', { style: { color: T.label1, fontSize: 14, fontWeight: 600 } }, '员工档案')),
        h('div', { style: { flex: 1, overflowY: 'auto', padding: 20 } },
          h('div', { style: { display: 'flex', gap: 14, alignItems: 'center' } },
            h(Avatar, { name: activeEmployee.name, size: 56 }),
            h('div', null,
              h('div', { style: { fontSize: 20, color: T.label1, fontWeight: 600 } }, activeEmployee.name),
              h('div', { style: { fontSize: 13, color: T.label2, marginTop: 4 } },
                (activeEmployee.post || '—') + ' · ' + stationText))),
          h('div', { style: { marginTop: 16, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: T.label2 } },
            h('span', null, '工位 ' + (activeEmployee.member ? '@' + activeEmployee.member : '未绑定')),
            activeEmployee.stationSessionId ? h('span', null, '所在会话 ' + String(activeEmployee.stationSessionId).slice(0, 12)) : null,
            activeEmployee.model ? h('span', null, '模型 ' + activeEmployee.model) : null,
            activeEmployee.hiredAt ? h('span', null, '入职 ' + String(activeEmployee.hiredAt).slice(0, 10)) : null),
          //13.0.2 工位诊断条：缺失时当场可重建，不用先去发一条消息试错；文案解释「为什么会缺」
          activeStation === 'missing'
            ? h('div', {
              style: {
                marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                background: T.layer2, border: '1px solid ' + T.border1, borderLeft: '3px solid ' + T.warn,
                borderRadius: 10,
              },
            },
              h('div', { style: { flex: 1, fontSize: 12, color: T.label2, lineHeight: 1.7 } },
                'teammate 是会话内实体：它所在的会话结束后，名册只剩一个名字，工位就是空壳。重建会在最空闲的会话里重新落座并投递。'),
              h('button', {
                type: 'button',
                onClick: () => run(activeEmployee.name + ' 上线', 'wake', { scope: { kind: 'employee', name: activeEmployee.name } }),
                style: {
                  cursor: 'pointer', fontSize: 12, padding: '6px 12px', borderRadius: 8,
                  color: T.labelOnBrand, background: T.brand, border: 'none', flex: '0 0 auto',
                },
              }, '重建工位并上线'))
            : null,
          h('div', { style: { marginTop: 20, fontSize: 13, color: T.label1, fontWeight: 600 } }, '岗位说明书'),
          h('div', {
            style: {
              marginTop: 8, fontSize: 12, color: T.label2, whiteSpace: 'pre-wrap', lineHeight: 1.75,
              background: T.layer2, border: '1px solid ' + T.border1, borderRadius: 10, padding: 12,
            },
            //14.0.46.1 括号式占位（未填写）读起来像错误提示；统一成陈述句「未填写」
          }, activeEmployee.duty || '未填写'),
          h('div', { style: { marginTop: 20, fontSize: 13, color: T.label1, fontWeight: 600 } }, '未完成任务'),
          (activeEmployee.open && activeEmployee.open.length > 0)
            //14.0.16 任务键兜底：快照理论上不会给 null，但历史脏数据不该把整页带走
            //14.0.41.3 任务清单限高内部滚动（审计 P2-9）：任务一多，档案页底部的离职入口被推走
            ? h('div', { style: { maxHeight: 260, overflowY: 'auto' } },
              activeEmployee.open.map((task, index) => h(TaskRow, { key: (task && task.id) || 'task-' + index, task: task })))
            //14.0.46.2 只写「暂无」丢了对象：空的是「未完成任务」，不是整个档案页没有内容
            : h('div', { style: { fontSize: 12, color: T.label2, padding: '8px 0' } }, '暂无未完成任务'),
          h('div', { style: { marginTop: 20, fontSize: 13, color: T.label1, fontWeight: 600 } }, '所在群'),
          (function () {
            const mine = groups.filter((group) => (group.members || []).indexOf(activeEmployee.name) >= 0)
            //14.0.46.3 「不在任何群」是结论式否定，改成状态陈述并与空态口径一致
            if (mine.length === 0) return h('div', { style: { fontSize: 12, color: T.label2, padding: '8px 0' } }, '还没有加入任何群')
            //14.0.41.4 群名同样限宽省略：一个长群名会把「所在群」列表顶成多行
            return mine.map((group) => h('div', {
              key: group.id,
              title: group.name,
              style: { fontSize: 12, color: T.label2, padding: '4px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, '· ' + group.name + '（' + (group.members || []).length + ' 人）'))
          })(),
          //13.0.3 解雇：归档而非物理删除，保留历史任务与档案，需二次确认
          h('div', { style: { marginTop: 26, paddingTop: 16, borderTop: '1px solid ' + T.border1 } },
            h('button', {
              type: 'button',
              onClick: () => confirmAsk({
                title: '让「' + activeEmployee.name + '」离职？',
                text: '档案与历史任务会保留，但不再计入在职员工。',
                confirmText: '让其离职',
                danger: true,
                onOk: () => {
                  run('解雇 ' + activeEmployee.name, 'staff-fire', { name: activeEmployee.name })
                  setShowDetail(false)
                },
              }),
              style: {
                cursor: 'pointer', fontSize: 12, padding: '6px 14px', borderRadius: 14,
                color: T.danger, background: 'transparent', border: '1px solid ' + T.danger,
              },
            }, '让该员工离职'),
            h('div', { style: { fontSize: 11, color: T.label2, marginTop: 6 } }, '离职为归档：档案与历史任务保留，可随时重新招募同名员工。')))) : null

      //13.6 右侧：按当前会话渲染聊天区
      let chat = null
      if (showDetail && activeEmployee) {
        chat = detailPanel
      } else if (loadingFirst) {
        //14.0.14 首屏快照未到（含重载窗口）：右栏先给 3 行详情骨架，别让用户先看到一屏空态再跳成内容
        chat = h(SkeletonDetail, { rows: 3 })
      } else if (activeGroup) {
        //13.6.1 群成员：带岗位与在线状态，@ 候选与成员列表共用同一份
        const groupMembers = (activeGroup.members || []).map((name) => {
          const employee = employees.find((item) => item.name === name)
          //14.0.15 成员条要三色状态点：station 与列表行同源；查不到快照按未绑定处理，不编造在线态
          return { name: name, post: employee ? (employee.post || '') : '', online: Boolean(employee && employee.online), station: employeeStationOf(employee) }
        })
        chat = h(ChatPane, {
          title: activeGroup.name,
          subtitle: (activeGroup.members || []).join('、')
            + ' · 今日 ' + (activeGroup.todayCount || 0) + ' 条'
            + (activeGroup.secretary ? ' · 秘书 ' + activeGroup.secretary : '')
            + (activeGroup.workspace ? ' · 工作区 ' + activeGroup.workspace : ''),
          messages: groupMessages,
          members: groupMembers,
          mentionables: groupMembers,
          //14.0.27 悬空成员随快照下传：成员条与群头部警示共用一份，口径不各算各的
          dangling: activeGroup.danglingMembers || [],
          //13.6.3 跨天检测：群最后一条消息不在今天时提示开新会话，历史仍可翻阅
          hint: (function () {
            //13.6.4 同步改用最后一条消息的工作日，避免提示与按钮不一致
            const lastKey = activeGroup.lastDayKey || null
            if (!lastKey) return '群发言会投递并唤醒所有成员；@ 某人则只投递给他'
            if (lastKey !== activeGroup.currentDay) {
              return '本群上次活动在 ' + lastKey + '，今天是 ' + activeGroup.currentDay
                + '；建议新建会话后继续（历史消息仍保留在下方可翻阅）'
            }
            return '群发言会投递并唤醒所有成员；@ 某人则只投递给他'
          })(),
          onWake: () => run('拉起群内成员', 'wake', { scope: { kind: 'group', id: activeGroup.id } }),
          wakeTitle: '让本群成员上线（只处理本群 ' + groupMembers.length + ' 人）',
          //13.6.2 群管理：移出成员、解散群，均二次确认
          //13.8.1 工作区：一个按钮完成绑定与换绑，清空输入即解除绑定
          workspaceLabel: activeGroup.workspace ? '工作区' : '设工作区',
          workspaceTitle: activeGroup.workspace
            ? '当前工作区：' + activeGroup.workspace + '，点击可换绑或清空解除'
            : '点击为本群绑定一个工作区',
          onWorkspace: () => {
            //13.8.3 用自绘弹层取值，不用 window.prompt（Electron 不支持）
            openDialog(
              '输入本群的工作区绝对路径（例如 E:/DSH）；留空并确定表示解除绑定。',
              activeGroup.workspace || '',
              (input) => {
                const next = String(input == null ? '' : input).trim()
                run(next === '' ? '解除工作区' : '绑定工作区', 'group-update', {
                  groupId: activeGroup.id,
                  workspace: next,
                })
              },
            )
          },
          //13.10.0 一键：在群绑定工作区新建会话，等它就绪后自动把该群成员拉上线
          onOneClickOnline: (function () {
            if (!activeGroup.workspace) return null
            return () => {
              const ui = uiWorkspaceService()
              if (!ui || typeof ui.startSession !== 'function') {
                setNotice({ ok: false, text: '当前客户端不支持新开会话' })
                return
              }
              if (!activeGroup.workspaceId) {
                setNotice({ ok: false, text: '该群还没有工作区 id，请先绑定工作区' })
                return
              }
              const groupId = activeGroup.id
              const groupName = activeGroup.name
              setNotice({ ok: true, text: '正在为「' + groupName + '」新建会话…' })
              try {
                ui.startSession(activeGroup.workspaceId)
              } catch (error) {
                setNotice({ ok: false, text: '新建会话失败：' + (error instanceof Error ? error.message : String(error)) })
                return
              }
              //13.10.1 让面板保持可见，同时给新会话 3 秒就绪时间，再按群上线
              setTimeout(() => {
                try { setPanelOpen(true) } catch (error) { /* 面板已销毁则忽略 */ }
                setNotice({ ok: true, text: '会话已建，正在拉起「' + groupName + '」成员…' })
                callAction('wake', { scope: { kind: 'group', id: groupId } })
                  .then((result) => {
                    const rows = result && Array.isArray(result.results) ? result.results : []
                    const ok = rows.filter((item) => item.ok)
                    const bad = rows.filter((item) => !item.ok)
                    const head = '「' + groupName + '」上线完成：成功 ' + ok.length + '，失败 ' + bad.length
                    const detail = bad.length > 0
                      ? '｜' + bad.map((item) => item.name + ':' + String(item.reason).slice(0, 40)).join('；')
                      : ''
                    setNotice({ ok: bad.length === 0, level: bad.length === 0 ? 'ok' : (ok.length > 0 ? 'warn' : 'error'), text: head + detail })
                  })
                  .catch((error) => {
                    setNotice({ ok: false, text: '上线失败：' + (error instanceof Error ? error.message : String(error)) })
                  })
              }, 3200)
            }
          })(),
          //13.7.1 新任务：群绑定工作区后常驻显示，不依赖是否跨天
          onRotate: (function () {
            //13.7.1c 只要有绑定路径就给入口；路径不在 DSH 工作区列表时点击会自动补建
            if (!activeGroup.workspace) return null
            return () => {
              const ui = uiWorkspaceService()
              if (!ui || typeof ui.startSession !== 'function') {
                setNotice({ ok: false, text: '当前客户端不支持新开会话' })
                return
              }
              //13.7.3 拿到 id 后统一走这一个出口，避免两处逻辑分叉
              const openWith = (workspaceId) => {
                try {
                  ui.startSession(workspaceId)
                  //13.7.6 startSession 会切到新会话视图，把员工中心重新拉回来，避免「一点就跳走」
                  setTimeout(() => {
                    try { setPanelOpen(true) } catch (error) { /* 面板已被销毁则忽略 */ }
                  }, 600)
                  setNotice({ ok: true, text: '已在 ' + activeGroup.workspace + ' 开启新会话，员工中心保持打开' })
                } catch (error) {
                  setNotice({ ok: false, text: '新开会话失败：' + (error instanceof Error ? error.message : String(error)) })
                }
              }
              //13.7.4 已解析到 id 直接开
              if (activeGroup.workspaceId) { openWith(activeGroup.workspaceId); return }
              //13.7.5 未解析说明该路径还没登记为工作区，先用 workspaces.create 补建
              const repo = workspacesService()
              if (!repo || typeof repo.create !== 'function') {
                setNotice({ ok: false, text: '路径「' + activeGroup.workspace + '」还不是 DSH 工作区，请先在主界面添加' })
                return
              }
              Promise.resolve(repo.create({ path: activeGroup.workspace }))
                .then((view) => {
                  const id = view && (view.id || view.workspaceId)
                  if (id) openWith(id)
                  else setNotice({ ok: false, text: '创建工作区未返回 id，请在主界面手动添加该路径' })
                })
                .catch((error) => {
                  setNotice({ ok: false, text: '创建工作区失败：' + (error instanceof Error ? error.message : String(error)) })
                })
            }
          })(),
          onMemberMenu: (memberName, event) => {
            setMenu({
              x: Math.min(event.clientX, window.innerWidth - 180),
              y: Math.min(event.clientY, window.innerHeight - 170),
              title: memberName,
              items: [
                { label: '发私聊', action: () => { setSelected('dm:' + memberName); setShowDetail(false) } },
                { label: '查看资料', action: () => { setSelected('dm:' + memberName); setShowDetail(true) } },
                {
                  label: '移出本群',
                  danger: true,
                  action: () => confirmAsk({
                    title: '把「' + memberName + '」移出「' + activeGroup.name + '」？',
                    text: '移出后该成员不再收到本群消息，可随时重新加回。',
                    confirmText: '移出',
                    danger: true,
                    onOk: () => run('移出 ' + memberName, 'group-kick', { groupId: activeGroup.id, member: memberName }),
                  }),
                },
              ],
            })
          },
          onKick: (memberName) => confirmAsk({
            title: '把「' + memberName + '」移出「' + activeGroup.name + '」？',
            text: '移出后该成员不再收到本群消息，可随时重新加回。',
            confirmText: '移出',
            danger: true,
            onOk: () => run('移出 ' + memberName, 'group-kick', { groupId: activeGroup.id, member: memberName }),
          }),
          onDeleteGroup: () => confirmAsk({
            title: '解散「' + activeGroup.name + '」？',
            text: '群消息会一并删除，不可恢复。',
            confirmText: '解散',
            danger: true,
            onOk: () => {
              run('解散群', 'group-delete', { groupId: activeGroup.id })
              setSelected(null)
            },
          }),
          onSend: (text, mention) => run('群发言', 'group-send', { groupId: activeGroup.id, text: text, mention: mention || undefined }),
          onError: (message) => setNotice({ ok: false, text: message }),
        })
      } else if (activeEmployee) {
        chat = h(ChatPane, {
          title: activeEmployee.name,
          subtitle: (activeEmployee.post || '—') + ' · ' + (activeEmployee.member ? (activeEmployee.online ? '在线' : '离线') + ' @' + activeEmployee.member : '未绑定工位'),
          placeholder: activeEmployee.member ? '给' + activeEmployee.name + '发消息' : '该员工未绑定工位，无法私聊',
          messages: dmMessages,
          members: [],
          mentionables: [],
          hint: activeEmployee.member ? '员工回复会以消息形式出现在主对话中' : null,
          onTitleClick: () => setShowDetail(true),
          onWake: activeEmployee.member
            ? () => run(activeEmployee.name + ' 上线', 'wake', { scope: { kind: 'employee', name: activeEmployee.name } })
            : null,
          wakeTitle: '只让 ' + activeEmployee.name + ' 上线',
          onSend: (text) => run('发送给 ' + activeEmployee.name, 'dm', { employee: activeEmployee.name, text: text }),
          onError: (message) => setNotice({ ok: false, text: message }),
        })
      } else {
        chat = h('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.label2, fontSize: 13 } }, '选择左侧会话开始')
      }

      //14.0.2 提示条三态：颜色 + 前缀符号（不只靠颜色区分，色弱也能读懂），长文本换行不撑破面板
      const noticeBar = notice
        ? (function () {
          const tone = noticeTone(noticeLevelOf(notice))
          //14.0.23 warn/error 不自动消失，必须给明确关闭入口，否则横幅永久占位
          const level = noticeLevelOf(notice)
          return h('div', {
            style: {
              padding: '6px 14px', fontSize: 12, color: tone.color, background: tone.background,
              borderBottom: '1px solid ' + T.border1, display: 'flex', gap: 8, alignItems: 'flex-start',
            },
          },
            h('span', { style: { flex: '0 0 auto', fontWeight: 600 } }, tone.badge),
            h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, notice.text),
            level === 'ok'
              ? null
              : h('button', {
                type: 'button',
                onClick: () => setNotice(null),
                title: '关闭提示',
                'aria-label': '关闭提示',
                //14.0.39.3 纯符号按钮统一命中区：只有「×」时命中区靠字形 13px 撑，点不准
                style: Object.assign({ all: 'unset', cursor: 'pointer', flex: '0 0 auto', fontSize: 13, color: T.label2, lineHeight: 1.2 }, HIT),
              }, '×'))
        })()
        : null

      //17.8.11.4 陈旧数据提示条：沿用 notice 的 warn 级配色与前缀符号，但独立于操作提示——
      //          操作提示会在切换会话时被清空（14.0.22），陈旧是数据状态，必须一直挂到刷新成功为止
      const snapshotStaleBar = snapshotStale
        ? (function () {
          const tone = noticeTone('warn')
          return h('div', {
            //14.0.40.3 陈旧条标题与文案同源：title 给完整解释，行内文字复用同一条过期限定语
            title: COPY.staleHint,
            style: {
              padding: '6px 14px', fontSize: 12, color: tone.color, background: tone.background,
              borderBottom: '1px solid ' + T.border1, display: 'flex', gap: 8, alignItems: 'center',
            },
          },
            h('span', { style: { flex: '0 0 auto', fontWeight: 600 } }, tone.badge),
            h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, COPY.staleNote),
            //17.8.11.5 手动刷新走 reload（先 ping 换票再拉），与「立即重试」同一入口语义
            h('button', {
              type: 'button',
              onClick: () => snapshot.reload(),
              title: '重新拉取员工数据',
              //14.0.40.4 按钮词统一成同 COPY.retry：原来这里叫「立即刷新」、左栏叫「立即重试」，用户不知道是否等价
              'aria-label': COPY.retry,
              style: Object.assign({ all: 'unset', cursor: 'pointer', flex: '0 0 auto', fontSize: 12, color: T.brand }, HIT),
            }, COPY.retry))
        })()
        : null

      //13.0.5 右键菜单浮层：与企微一致的三项式布局，鼠标移出自动收起
      const contextMenu = menu ? h('div', {
        //14.0.45.3 容器挂 ref 供 14.0.45.1 判内外；role=menu 与菜单项的 role=menuitem 配对
        ref: menuRef,
        role: 'menu',
        style: {
          position: 'fixed', left: menu.x, top: menu.y, zIndex: 9600,
          background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 10,
          //14.0.41.5 菜单给上限宽度：换绑工作区那一项带完整路径，原来能把菜单撑到屏宽外（审计 P2-9 的 1825）
          boxShadow: '0 10px 30px rgba(0,0,0,0.28)', padding: 6, minWidth: 160, maxWidth: 360,
          pointerEvents: 'auto',
        },
        onMouseLeave: () => setMenu(null),
      },
        menu.title ? h('div', { style: { fontSize: 11, color: T.label2, padding: '4px 10px 6px' } }, menu.title) : null,
        menu.items.map((item, index) => h('button', {
          key: index,
          type: 'button',
          role: 'menuitem',
          onClick: () => { setMenu(null); item.action() },
          //14.0.41.6 单项也省略：文字进 title，路径再长也只在右侧裁掉，不把菜单撑破
          title: item.label,
          style: {
            all: 'unset', cursor: 'pointer', display: 'block', width: '100%', boxSizing: 'border-box',
            padding: '8px 12px', fontSize: 13, borderRadius: 6,
            color: item.danger ? T.danger : T.label1,
            maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, item.label))) : null

      //13.0.8 输入弹层：居中浮层 + 输入框 + 确定取消
      const dialogLayer = dialog
        ? h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 9700, background: 'rgba(0,0,0,0.32)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto',
          },
          onClick: () => setDialog(null),
        },
          h('div', {
            onClick: (event) => event.stopPropagation(),
            style: {
              background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 12,
              boxShadow: '0 16px 40px rgba(0,0,0,0.32)', padding: 18, width: 420, maxWidth: '90vw',
            },
          },
            h('div', { style: { fontSize: 13, color: T.label1, marginBottom: 10, lineHeight: 1.5 } }, dialog.title),
            h('input', {
              type: 'text',
              value: dialog.value,
              autoFocus: true,
              'aria-label': '输入内容',
              onChange: (event) => setDialog({ ...dialog, value: event.target.value }),
              onKeyDown: (event) => {
                //14.0.18 新建群/新建员工对话框同理：输入法上屏的回车不得误确认，避免用半个群名或人名提交
                if (event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing) && event.keyCode !== 229) { const next = dialog; setDialog(null); next.onConfirm(next.value) }
                //14.0.28.2 弹层自己吃掉 Esc：不 stopPropagation 会继续冒泡到 window，把员工中心一并关掉
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDialog(null) }
              },
              style: {
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13,
                borderRadius: 8, border: '1px solid ' + T.border1, background: T.layer1, color: T.label1,
              },
            }),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
              h('button', {
                type: 'button',
                onClick: () => setDialog(null),
                style: { cursor: 'pointer', fontSize: 12, padding: '6px 14px', borderRadius: 8, color: T.label2, background: 'transparent', border: '1px solid ' + T.border2 },
              }, '取消'),
              h('button', {
                type: 'button',
                onClick: () => { const next = dialog; setDialog(null); next.onConfirm(next.value) },
                style: { cursor: 'pointer', fontSize: 12, padding: '6px 14px', borderRadius: 8, color: T.labelOnBrand, background: T.brand, border: 'none' },
              }, '确定')))) : null

      //14.0.44.2 确认层：复用输入弹层同一套遮罩/卡片/键盘处理（点遮罩取消、卡片自己吃掉 Esc 不冒泡），
      //          差别只在正文是说明文本、主按钮可标 danger；六个破坏性动作统一渲染在这里，不再各弹各的原生窗口
      const confirmLayer = confirmState
        ? h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 9800, background: 'rgba(0,0,0,0.32)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto',
          },
          //14.0.50.5 点遮罩只负责清状态：焦点还回来源统一由 14.0.50.2 的 cleanup 承担，
          //          这样 Esc / 遮罩 / 取消 / 确定四条路径不需要各写一遍还焦点
          onClick: () => setConfirmState(null),
        },
          h('div', {
            //14.0.50.6 卡片拿 ref 并按 tabIndex -1 承接兜底焦点：桩环境建不出真实按钮时，焦点至少落在弹层里而不是背后页面
            ref: confirmCardRef,
            tabIndex: -1,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': confirmState.title,
            onClick: (event) => event.stopPropagation(),
            onKeyDown: (event) => {
              //14.0.44.3 确认层自己吃掉 Esc：与 14.0.28.2 同因——不 stopPropagation 会冒泡到 window，把整个员工中心关掉
              //14.0.50.7 Esc 只清状态、不跑动作；焦点仍由 14.0.50.2 的 cleanup 还回来源，Tab 交给 14.0.50.4 在卡片内自循环
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setConfirmState(null); return }
              if (event.key === 'Tab') { trapConfirmTab(event) }
            },
            style: {
              background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 12,
              boxShadow: '0 16px 40px rgba(0,0,0,0.32)', padding: 18, width: 420, maxWidth: '90vw',
            },
          },
            h('div', { style: { fontSize: 13, color: T.label1, fontWeight: 600, marginBottom: 8, lineHeight: 1.5 } }, confirmState.title),
            h('div', { style: { fontSize: 12, color: T.label2, lineHeight: 1.7, marginBottom: 16, wordBreak: 'break-word' } }, confirmState.text),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
              h('button', {
                type: 'button',
                //14.0.50.8 「取消」是打开时的初始焦点（14.0.50.2），也是 Tab 循环的起点
                ref: confirmCancelRef,
                onClick: () => setConfirmState(null),
                style: { cursor: 'pointer', fontSize: 12, padding: '6px 14px', borderRadius: 8, color: T.label2, background: 'transparent', border: '1px solid ' + T.border2 },
              }, '取消'),
              h('button', {
                type: 'button',
                //14.0.50.9 「确定」是循环里的第二个落点；动作执行与清状态都收口到 closeConfirm({ runOk: true })
                ref: confirmOkRef,
                onClick: () => closeConfirm({ runOk: true }),
                style: {
                  cursor: 'pointer', fontSize: 12, padding: '6px 14px', borderRadius: 8,
                  color: T.labelOnBrand, background: confirmState.danger ? T.danger : T.brand, border: 'none',
                },
              }, confirmState.confirmText))))
        : null

      const body = h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } }, left, chat)
      //13.9 主面板模式：铺满中央面板，不做遮罩
      if (inline) {
        //14.0.38 焦点轮廓用捕获阶段统一挂在容器上：面板内可聚焦元素有 18 个按钮 + 4 个输入框，
        //         逐个加 onFocus/onBlur 会让每个按钮都多一份重复逻辑；React 的 onFocusCapture 一次覆盖全部后代，
        //         新加按钮也自动具备，且不注入全局样式表
        return h('div', {
          onFocusCapture: focusRingOn,
          onBlurCapture: focusRingOff,
          style: {
            display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
            background: T.overlay, pointerEvents: 'auto',
          },
        }, header, noticeBar, snapshotStaleBar, body, contextMenu, dialogLayer, confirmLayer)
      }
      //13.9.2 浮层：居中卡片 + 遮罩；点遮罩、按 ESC、点右上 × 三条路都能退出
      return h('div', {
        //14.0.38.1 浮层同口径：捕获阶段挂在最外层，卡片内所有按钮/输入框都有焦点轮廓
        onFocusCapture: focusRingOn,
        onBlurCapture: focusRingOff,
        style: {
          position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 9000,
          background: 'rgba(0,0,0,0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          //13.7 shell.overlay 层默认点击穿透，必须显式接收指针事件
          pointerEvents: 'auto',
        },
        onClick: (event) => { if (event.target === event.currentTarget) setPanelOpen(false) },
      },
        h('div', {
          style: {
            //14.0.37.1 浮层宽度只留 2vw 侧边距，窄屏时多给内容 4vw；高度不变
            width: 'min(1100px, 96vw)', height: 'min(740px, 88vh)',
            background: T.overlay, border: '1px solid ' + T.border2, borderRadius: 14,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          },
        }, header, noticeBar, snapshotStaleBar, body, contextMenu, dialogLayer, confirmLayer))
    }

    //13.10 两个包装：浮层挂到 shell.overlay，主面板挂到 main
    function StaffOverlayMount() { return h(StaffCenter, {}) }
    function StaffPanelMount() { return h(StaffCenter, { inline: true }) }

    //13.11 侧栏面板图标：点击切到员工主面板
    //13.11 侧栏面板图标：id 必须与 main 的 key 一致（staff），侧栏据此自动建按钮并切面板
    function StaffPanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      const active = Boolean(props && props.active)
      return h('button', {
        type: 'button',
        title: '员工中心',
        onClick: () => setPanelOpen(true),
        style: {
          all: 'unset', cursor: 'pointer', width: size, height: size,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: Math.max(4, Math.round(size * 0.28)),
          fontSize: Math.max(9, Math.round(size * 0.55)),
          color: active ? T.brand : T.label2,
          background: active ? T.layer2 : 'transparent',
        },
      }, '员')
    }

    //15. 指令菜单：员工与群直达
    //15.2 目标暂存：菜单选中后把「打开哪个会话」交给员工中心，菜单与面板因此互不依赖
    const staffTargetStore = { pending: null, listeners: new Set() }
    //15.2.1 快照缓存：菜单行需要员工/群的岗位信息，8 秒内复用同一份，避免每次打开菜单都打 HTTP
    const staffSnapshotCache = { value: null, at: 0 }
    //15.2.2 指令注册状态：signature 不变就不重建，timer 记录 30 秒刷新器
    const staffCommandState = { disposers: [], signature: '', timer: null, sessionId: '' }

    //15.3 指定目标：优先写进当前会话的输入框，人留在当前对话，不弹员工中心
    //     只有拿不到当前输入框（未绑定会话 / 输入框未挂载 / 服务缺失）才退回员工中心，
    //     退回属于兜底路径，保证操作不会无声失败
    function requestStaffTarget(row) {
      if (!row || !row.target) return false
      staffTargetStore.pending = row.target
      if (insertStaffMention(row)) return true
      for (const listener of staffTargetStore.listeners) {
        try { listener(row.target) } catch (error) { console.error('[dsh-staff] 目标通知失败', error) }
      }
      setPanelOpen(true)
      return false
    }

    //15.3.1 写入输入框：在原有草稿末尾追加「@对象 」，不覆盖用户已经写的字
    //       走 conversation.input.shell(id) 的公开面：draftSnapshot 取旧草稿，setDraft 整体替换，focus 回焦
    function insertStaffMention(row) {
      const sessionId = staffCommandState.sessionId
      if (!sessionId) return false
      const conversation = conversationService()
      const input = conversation && conversation.input
      if (!input || typeof input.shell !== 'function') return false
      let shell = null
      try {
        shell = input.shell(sessionId)
      } catch (error) {
        //15.3.2 会话没有保留中的 binding（例如菜单在空会话里打开）时按兜底处理
        return false
      }
      if (!shell || typeof shell.setDraft !== 'function') return false
      let snapshot = null
      try {
        snapshot = shell.draftSnapshot && typeof shell.draftSnapshot === 'object' ? shell.draftSnapshot : null
      } catch (error) {
        //15.3.2 草稿快照读不到（输入框正在销毁等）时按兜底处理，不能把用户草稿吞掉
        return false
      }
      let previous = snapshot && typeof snapshot.text === 'string' ? snapshot.text : ''
      //15.3.2.1 斜杠令牌兜底：正常路径下指令面板已先消费掉 "/xxx"，这里只处理极端残留；
      //         仅当整段草稿就是一个单段斜杠令牌时才丢弃，像 "/home/user" 这种真实路径不动
      if (/^\/(?:[^\s\/]{0,40})$/.test(previous.trim())) previous = ''
      const separator = previous !== '' && !/\s$/.test(previous) ? ' ' : ''
      const mention = '@' + row.label + ' '
      try {
        shell.setDraft(previous + separator + mention)
      } catch (error) {
        console.error('[dsh-staff] 写入输入框失败', error)
        return false
      }
      if (typeof shell.focus === 'function') {
        try { shell.focus() } catch (error) { /* 焦点失败不影响草稿 */ }
      }
      //15.3.3 即时反馈：告诉用户指定了谁、什么岗位，避免「点了没反应」的观感
      if (typeof shell.notify === 'function') {
        const detail = staffRowDescription(row)
        try { shell.notify('info', '已指定「' + row.label + '」' + (detail ? '（' + detail + '）' : '') + '，消息由当前会话分派') } catch (error) { /* 通知失败忽略 */ }
      }
      return true
    }

    //15.4 读取快照：force 为真时跳过缓存；失败由调用方决定是否沿用旧数据
    async function loadStaffSnapshot(options) {
      const force = Boolean(options && options.force)
      const now = Date.now()
      if (!force && staffSnapshotCache.value && now - staffSnapshotCache.at < 8000) return staffSnapshotCache.value
      //17.8.9 指令路由与 / 菜单共用这份快照缓存，同样要带票据
      const res = await fetch('/staff-api/snapshot', snapshotInit())
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      staffSnapshotCache.value = data
      staffSnapshotCache.at = now
      return data
    }

    //15.5 行说明实时计算：在线状态与待办数随时会变，行本身只在人员/群增减时重建
    function staffRowDescription(row) {
      const snap = staffSnapshotCache.value
      if (row.kind === 'group') {
        const group = snap && Array.isArray(snap.groups) ? snap.groups.find((item) => item.id === row.groupId) : null
        if (!group) return '群'
        const members = Array.isArray(group.members) ? group.members : []
        const parts = ['群 · ' + members.length + ' 人']
        if (group.secretary) parts.push('秘书 ' + group.secretary)
        return parts.join(' · ')
      }
      const employee = snap && Array.isArray(snap.employees) ? snap.employees.find((item) => item.name === row.employeeName) : null
      if (!employee) return '员工'
      const parts = [employee.post ? employee.post : '未设岗位']
      //14.9.1 菜单描述同步工位三态：待重建 / 未绑定都要在选中前就看见，避免选中后才发现投不出去
      const station = employeeStationOf(employee)
      if (station === 'online') parts.push('在线')
      else if (station === 'missing') parts.push('待重建')
      const open = Array.isArray(employee.open) ? employee.open.length : 0
      if (open > 0) parts.push(open + ' 待办')
      return parts.join(' · ')
    }

    //15.6.1 行名用目标短哈希而不是序号：员工入职/归档会让序号整体位移，
    //       若以 "staff-employee-<n>" 命名，同一个人的行名会跟着变，菜单历史与高亮命中不到同一目标。
    //       哈希只由稳定身份（群 id / 员工姓名）派生，排序变化不再改名。
    function staffRowKey(seed) {
      let hash = 0x811c9dc5
      const text = String(seed == null ? '' : seed)
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return ('0000000' + hash.toString(16)).slice(-8)
    }

    //15.6 由快照生成菜单行：群在前、员工在后，各自按名称拼音序（只决定展示顺序，不参与行名）
    function staffCommandRows(snap) {
      const employees = snap && Array.isArray(snap.employees) ? snap.employees : []
      const groups = snap && Array.isArray(snap.groups) ? snap.groups : []
      const rows = []
      const sortedGroups = groups.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'))
      sortedGroups.forEach((group, index) => {
        rows.push({
          name: 'staff-group-' + staffRowKey(group.id || group.name || index),
          label: group.name || ('群 ' + (index + 1)),
          kind: 'group',
          groupId: group.id,
          target: 'group:' + group.id,
        })
      })
      const sortedEmployees = employees
        .filter((employee) => employee && employee.name && employee.status !== 'archived')
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
      sortedEmployees.forEach((employee, index) => {
        rows.push({
          name: 'staff-employee-' + staffRowKey(employee.name),
          label: employee.name,
          kind: 'employee',
          employeeName: employee.name,
          target: 'dm:' + employee.name,
        })
      })
      return rows
    }

    //15.7 按 signature 重建指令行：只有人员或群发生增减才重建，避免菜单频繁抖动
    function syncStaffCommands(command) {
      const rows = staffCommandRows(staffSnapshotCache.value)
      const signature = rows.map((row) => row.name + '|' + row.label + '|' + row.target).join('\n')
      if (signature === staffCommandState.signature) return
      //15.7.1 先撤销旧注册再注册，避免同名冲突；单行失败不影响其余行
      for (const dispose of staffCommandState.disposers) {
        try { dispose() } catch (error) { console.error('[dsh-staff] 指令撤销失败', error) }
      }
      staffCommandState.disposers = []
      staffCommandState.signature = signature
      for (const row of rows) {
        try {
          const dispose = command.register({
            name: row.name,
            label: () => row.label,
            description: () => staffRowDescription(row),
            available: () => true,
            //15.7.2 选中即指定：记下当前会话 id，再把对象写进它的输入框（不切换页面）
            ui: {
              kind: 'action',
              run: (session) => {
                if (session && session.sessionId) staffCommandState.sessionId = String(session.sessionId)
                requestStaffTarget(row)
              },
            },
          })
          staffCommandState.disposers.push(dispose)
        } catch (error) {
          console.error('[dsh-staff] 指令注册失败：' + row.name, error)
        }
      }
      //15.7.3 同步结果落一条日志：DevTools 里看到这行即代表 "/" 菜单已挂上员工与群
      console.log('[dsh-staff] "/" 菜单行已同步：' + rows.length + ' 条')
    }

    //15.8 挂载指令：取不到 commandUi 服务时静默降级，员工中心不受影响
    function registerStaffCommands(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['commandUi'], (scope) => {
        const command = typeof scope.get === 'function' ? scope.get('commandUi') : scope.commandUi
        if (!command || typeof command.register !== 'function') return
        //15.8.1 首次立即刷新，之后每 30 秒一次；刷新失败沿用上次注册，菜单不消失
        const refresh = async () => {
          try {
            await loadStaffSnapshot({ force: true })
            syncStaffCommands(command)
          } catch (error) {
            console.error('[dsh-staff] 员工快照刷新失败，菜单沿用上次数据', error)
          }
        }
        if (typeof scope.effect !== 'function') {
          refresh()
          return
        }
        scope.effect(() => {
          refresh()
          staffCommandState.timer = setInterval(refresh, 30000)
          return () => {
            if (staffCommandState.timer) clearInterval(staffCommandState.timer)
            staffCommandState.timer = null
            for (const dispose of staffCommandState.disposers) {
              try { dispose() } catch (error) { console.error('[dsh-staff] 指令撤销失败', error) }
            }
            staffCommandState.disposers = []
            staffCommandState.signature = ''
          }
        }, 'dsh-staff: / 菜单员工与群')
      })
    }

    //17. @ 真路由：输入框里「@群名 内容」发到群，「@员工名 内容」私聊该员工
    //17.0 框架没有发送前钩子：Enter 最终落到 conversation.sendSession（conv-client.js:4685），
    //     外部插件只能包这层实例方法；命中已知对象才改投，其余原样透传，包不上就自动放弃，不影响正常发送
    const staffRouteState = { installed: false, service: null, original: null }

    //17.1 解析路由：只认「@ + 已知名字 + 空白 + 正文」，名字取最长匹配，避免「张三」吃掉「张三丰」
    function resolveStaffRouteText(text, attachmentIds) {
      if (typeof text !== 'string') return null
      if (Array.isArray(attachmentIds) && attachmentIds.length > 0) return null
      const trimmed = text.trim()
      if (trimmed.charAt(0) !== '@') return null
      const rows = staffCommandRows(staffSnapshotCache.value)
      let matched = null
      for (const row of rows) {
        const label = String(row && row.label ? row.label : '')
        if (label === '' || trimmed.indexOf('@' + label) !== 0) continue
        const rest = trimmed.slice(label.length + 1)
        //17.1.1 名字后面必须是空白/常用分隔符或结尾：@张三丰 不能被当成 @张三，@陈默：xxx 也要认
        if (rest !== '' && !/^[\s：:，,、]/.test(rest)) continue
        if (matched === null || label.length > matched.row.label.length) matched = { row: row, rest: rest }
      }
      if (matched === null) return null
      const body = matched.rest.replace(/^[\s：:，,、]+/, '').trim()
      //17.1.2 只有名字没有正文时不改投：按普通消息发送，避免吞掉用户的半句话
      if (body === '') return null
      return { row: matched.row, body: body }
    }

    //17.2.0 群内点名：只在正文里找本群成员，取最长名字，避免「陈默」抢走「陈默然」
    function detectGroupMention(groupId, body) {
      const snap = staffSnapshotCache.value
      const groups = snap && Array.isArray(snap.groups) ? snap.groups : []
      const group = groups.find((item) => item && item.id === groupId)
      const members = group && Array.isArray(group.members) ? group.members : []
      let hit = null
      for (const name of members) {
        const label = String(name || '')
        if (label === '' || body.indexOf('@' + label) < 0) continue
        if (hit === null || label.length > hit.length) hit = label
      }
      return hit
    }

    //17.2 投递：群走 group-send（老板发言仍按秘书规则投递），员工走 dm（先落盘再投递）
    async function dispatchStaffRoute(route) {
      const row = route.row
      if (row.kind === 'group') {
        //17.2.1 正文里点了本群成员就带 mention：与界面上的群发言完全同一条逻辑（client.js:1319）
        const mention = detectGroupMention(row.groupId, route.body)
        const payload = { groupId: row.groupId, text: route.body }
        if (mention !== null) payload.mention = mention
        const result = await callAction('group-send', payload)
        const delivered = result && typeof result.delivered === 'number' ? result.delivered : null
        return '已投递到群「' + row.label + '」' + (mention === null ? '' : '（点名 ' + mention + '）') +
          (delivered === null ? '' : '（送达 ' + delivered + ' 人）')
      }
      const dmResult = await callAction('dm', { employee: row.employeeName, text: route.body })
      //17.2.2 工位是会话内实体：成员缺失时服务端会重建工位再投递，提示里说清楚，别让老板以为还是原来那个
      const repaired = !!(dmResult && dmResult.repaired)
      return '已私聊「' + row.label + '」' + (repaired ? '（工位已重建）' : '')
    }

    //17.3 会话内提示：retained binding → shell.notify；拿不到提示面就静默，不能让提示失败把投递判成失败
    function notifyStaffRoute(session, level, text) {
      const conversation = conversationService()
      const input = conversation && conversation.input
      if (!input || typeof input.shellFor !== 'function') return
      let binding = null
      try {
        const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : undefined
        binding = sessions && typeof sessions.binding === 'function' ? sessions.binding(session && session.sessionId) : null
      } catch (error) {
        binding = null
      }
      if (!binding) return
      try {
        const shell = input.shellFor(binding)
        if (shell && typeof shell.notify === 'function') shell.notify(level, text)
      } catch (error) { /* 17.3.1 提示面不可用（会话正在销毁）时忽略 */ }
    }

    //17.4 挂载：包 conversation.sendSession；方法不存在或不可写（升级改了结构）就返回 false，行为回到纯文本
    //17.4.0 conversation 服务可能比本插件晚加载，用 ctx.inject 等它出现，不在 apply 时抢跑
    function installStaffSendRouter(ctx) {
      if (typeof ctx.inject !== 'function') return false
      ctx.inject(['conversation'], (scope) => {
        const service = typeof scope.get === 'function' ? scope.get('conversation') : scope.conversation
        attachStaffSendRouter(service, scope)
      })
      return true
    }

    //17.4.2 真正挂载：service 是 conversation 实例，scope 提供 effect 卸载钩子
    function attachStaffSendRouter(conversation, scope) {
      if (!conversation || typeof conversation.sendSession !== 'function') return false
      if (conversation.__dshStaffRouted === true) return true
      const original = conversation.sendSession
      const routed = async function staffRoutedSendSession(session, text, attachmentIds, mode, signal) {
        let route = resolveStaffRouteText(text, attachmentIds)
        //17.4.1 快照可能还没加载（没开过菜单）：命中失败且过期时强制刷一次再判，容忍刚入职的人
        if (route === null && typeof text === 'string' && text.trim().charAt(0) === '@') {
          const stale = !staffSnapshotCache.value || Date.now() - staffSnapshotCache.at > 8000
          if (stale) {
            try {
              await loadStaffSnapshot({ force: true })
              route = resolveStaffRouteText(text, attachmentIds)
            } catch (error) {
              route = null
            }
          }
        }
        if (route === null) return original.call(conversation, session, text, attachmentIds, mode, signal)
        try {
          const notice = await dispatchStaffRoute(route)
          notifyStaffRoute(session, 'info', notice)
          console.log('[dsh-staff] @ 路由：' + notice)
          //17.5 返回 success 让输入框按正常发送收尾（清空草稿、退出 submitting），当前会话不落这条消息
          return { kind: 'success' }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          //17.5.1 失败返回 error：输入框保留草稿并给出原因，用户改完可直接重发
          return { kind: 'error', text: '@ 投递失败：' + message }
        }
      }
      try {
        conversation.sendSession = routed
        conversation.__dshStaffRouted = true
      } catch (error) {
        console.error('[dsh-staff] @ 真路由挂载失败，退回普通发送', error)
        return false
      }
      staffRouteState.installed = true
      staffRouteState.service = conversation
      staffRouteState.original = original
      //17.6 卸载还原：热更新或卸载时把原方法放回去，避免下次加载包出双层
      if (scope && typeof scope.effect === 'function') {
        scope.effect(() => () => {
          if (conversation.__dshStaffRouted === true) {
            conversation.sendSession = original
            delete conversation.__dshStaffRouted
          }
          staffRouteState.installed = false
          staffRouteState.service = null
          staffRouteState.original = null
        }, 'dsh-staff: @ 真路由')
      }
      console.log('[dsh-staff] @ 真路由已挂载：@群名 发群、@员工名 私聊')
      return true
    }

    return {
      //2.4 layout 是主面板切换的必要服务，必须显式注入；否则 selectPanel 永远调不到
      inject: ['slots', 'layout', 'uiWorkspace', 'workspaces'],
      apply(ctx) {
        clientCtx = ctx
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'dsh-staff-bar', order: 10,
        }, StaffBar))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'dsh-staff-entry', order: 5, label: '员工',
        }, StaffEntry))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'dsh-staff-center', order: 50,
        }, StaffOverlayMount))
        //13.12 主面板：与对话页同级的独立页面，由 ctx.layout.selectPanel('staff') 切换
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'staff',
        }, StaffPanelMount))
        //13.13 侧栏面板列表入口
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'staff', order: 10, label: '员工',
        }, StaffPanelIcon))
        //15.9 "/" 指令菜单：每个员工、每个群各一行，选中直达对应会话
        registerStaffCommands(ctx)
        //17.7 @ 真路由：选中后输入正文回车即直投群/员工，当前会话不再收这条消息
        installStaffSendRouter(ctx)
      },
    }
  },
})
