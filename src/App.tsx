import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Globe as GlobeIcon, Moon, Sun, Wallet, Wrench } from "lucide-react"

import { Billing } from "@/components/Billing"
import { CardStyleMenu } from "@/components/CardStyleMenu"
import { NodeCard } from "@/components/NodeCard"
import { CompactList } from "@/components/CompactList"
import { DetailLoader, warmNodeDetail } from "@/components/DetailLoader"
import { Globe } from "@/components/Globe"
import { SearchBox, SearchRow } from "@/components/SearchBox"
import { SummaryCards } from "@/components/Summary"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, groupView, useNodes } from "@/lib/api"
import { regionView } from "@/lib/globe"
import { hasDetailRemarks } from "@/lib/notes"
import { searchNodes } from "@/lib/search"
import { hasGroupTabs, hasSummary, isBudgetLayout, LatencyStyleContext, useCardStyle, useGlobeVisible, useLocalFarm, useThemeConfig } from "@/lib/theme-config"
import { isBeijingNight, readThemePreference, resolveDark, type ThemeMode } from "@/lib/site-settings"
import type { LatencyStyle, RemarkPlacement } from "@/lib/site-settings"
import { FarmIcon } from "@/components/FarmIcon"

type Me = {
  authed: boolean
  github: boolean
  site_name: string
  public_page: boolean
  /** hub 的历史保留天数（1~365，1.3.2 起默认 30） 老 hub 不给：时间范围按 7 天算（@/lib/ranges） */
  history_days?: number
}

const TITLE_CACHE_KEY = "casurea:site_name"

/**
 * 接管标签页标题：index.html 的内联脚本在冷启动时也 fetch /api/me，可能几秒后才答；
 * `__titleOwned` 就是让那份响应让位的标志 —— 在 `/node/{id}` 上晚到的站名会把节点名抹掉
 * `/node/{id}` 是会被收藏分享的页面，标题要带上节点名；站名用 hub 的（允许改名）
 * `me` 到位前不写：否则每次加载都先翻一个占位标题写下的站名记进 localStorage，
 * 下次冷启动（index.html 的内联脚本）先用它而不是占位符
 */
function ownTitle(nodeName: string | undefined, siteName: string) {
  ;(window as unknown as { __titleOwned?: boolean }).__titleOwned = true
  document.title = [nodeName, siteName].filter(Boolean).join(" · ")
  try {
    localStorage.setItem(TITLE_CACHE_KEY, siteName)
  } catch {
    // 隐私模式 / 存储被禁：标题照写，重载回退占位符
  }
}

// 页脚署名里指向的源码仓库 —— 与 theme.json 的 `url` 是同一个地址 两处一起改
const REPO_URL = "https://github.com/YoungYannick/monitor-theme-casurea"
const ENGINE_URL = "https://github.com/monitor-probe/monitor"

// 图表 chunk 单独拆出（列表页不画图，首屏能小一半）；取的时机见 warmDetail
// 加载由 DetailLoader 与紧凑展开共享；失败时提供刷新与返回入口

/**
 * 详情页的骨架：按详情页真实的那几块摆，高度必须跟加载完的内容一样，
 * 否则那一下会「先塌再撑」
 */
function DetailSkeleton({ hasRemarks = false }: { hasRemarks?: boolean }) {
  return (
    <div className="detail-skeleton space-y-4" aria-busy="true">
      <div className="flex items-center gap-2">
        <Skeleton className="size-6 shrink-0 rounded-[3px]" />
        <Skeleton className="h-7 w-44" />
      </div>
      <div className="grid gap-x-6 gap-y-3 md:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="min-w-0">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>
      {/* 备注块：与真实页同一条件决定画不画（判据见 @/lib/notes），没备注时零占位 */}
      {hasRemarks && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Skeleton className="h-[22px] w-24 rounded-full" />
          <Skeleton className="h-[22px] w-16 rounded-full" />
        </div>
      )}
      <div className="space-y-2 border-t pt-4">
        <div className="flex gap-1">
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-6 w-16" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-16" />
        </div>
        <Skeleton className="h-4 w-36" />
      </div>
      {/* 四张资源图（整页详情的默认页签）：是上面页签块的**兄弟**，别嵌进去 */}
      <div className="space-y-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="mb-2 h-4 w-16" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

// `/node/{id}` 和 `/billing` 是真页面：刷新存活、可被链接分享 hub 对未知路径都答 index.html，
// 不需要服务端路由
function useAppRoute() {
  const read = () => {
    if (location.pathname === "/billing") return { node: null as number | null, billing: true }
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return { node: match ? (Number(match[1]) as number | null) : null, billing: false }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const sync = () => setRoute(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    route,
    // 列表 ↔ 详情；去首页时账单路由自然让位
    (next: number | null) => {
      history.pushState({}, "", next === null ? "/" : `/node/${next}`)
      setRoute({ node: next, billing: false })
      scrollTo(0, 0)
    },
    // 列表/详情 ↔ 账单：账单是独立路由，从详情页也能直接过去
    (on: boolean) => {
      history.pushState({}, "", on ? "/billing" : "/")
      setRoute({ node: null, billing: on })
      scrollTo(0, 0)
    },
  ] as const
}

const DARK_MEDIA = matchMedia("(prefers-color-scheme: dark)")

/**
 * 访客自己的选择，没有时跟系统的 只有开关写记录：加载时把系统答案存下来会把它钉死
 * `/admin/` 的面板同源共用这个 key，必须守同一条规则
 * 系统答案用订阅（useSyncExternalStore）而非拷进 state：首渲染与挂监听之间落下的
 * 一次翻转才不会漏听
 */
function useTheme(siteMode: ThemeMode) {
  const [saved, setSaved] = useState(readThemePreference)
  const system = useSyncExternalStore(
    (notify) => {
      DARK_MEDIA.addEventListener("change", notify)
      return () => DARK_MEDIA.removeEventListener("change", notify)
    },
    () => DARK_MEDIA.matches,
  )
  // 「随北京时间自动」要自己跨过 19:00 / 07:00：北京时间与系统明暗一样是**外部系统**，
  // 用订阅而非拷进 state —— 首渲染与挂监听之间的一次翻转才不会漏听 每分钟问一次
  // 到点前后最多差一分钟；别的档不挂这个定时器
  const subscribeNight = useCallback(
    (notify: () => void) => {
      if (siteMode !== "auto") return () => {}
      const timer = setInterval(notify, 60_000)
      return () => clearInterval(timer)
    },
    [siteMode],
  )
  const night = useSyncExternalStore(subscribeNight, isBeijingNight)
  // 站长那一档是**默认**；访客点过那枚图标（localStorage 里有 `theme`）就以他的为准
  const fromSite = siteMode === "auto" ? night : resolveDark(siteMode, system)
  const dark = saved ? saved === "dark" : fromSite

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    /**
     * 手机浏览器那一圈（地址栏 / 状态栏）的 `theme-color` 跟着**页面实际用的**明暗走
     * index.html 里那两份是按**系统**明暗挑的静态值，「随北京时间自动」在夜里与系统
     * 相反时两边会打架 —— 先摘掉那两份，再挂一份没有 media 的 颜色取 `--background`
     * 的实际值（oklch 交给 canvas 读回 sRGB），不手抄 hex
     */
    const head = document.head
    for (const old of head.querySelectorAll('meta[name="theme-color"]')) old.remove()
    const meta = document.createElement("meta")
    meta.name = "theme-color"
    let color = dark ? "#0d0c0a" : "#fafafa"
    const probe = document.createElement("canvas")
    probe.width = probe.height = 1
    const ctx = probe.getContext("2d")
    if (ctx) {
      // 先铺兜底色：老浏览器不认 oklch 时这次赋值会被忽略，留下的就是它
      ctx.fillStyle = color
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
      color = `rgb(${r}, ${g}, ${b})`
    }
    meta.content = color
    head.append(meta)
  }, [dark])

  return [
    dark,
    () => {
      const next = dark ? "light" : "dark"
      // 点成与站长那一档一致时**删掉记录**（= 重新跟着站长走，与 useGlobeVisible 同一套口径）
      const record = (next === "dark") === fromSite ? null : next
      try {
        if (record === null) localStorage.removeItem("theme")
        else localStorage.setItem("theme", record)
      } catch {
        // 存储被禁用（隐私模式）：这次会话照样切，只是记不住
      }
      setSaved(record)
    },
  ] as const
}

export default function App() {
  const config = useThemeConfig()
  // header / main / footer 三处共用的内容宽度：1280 保底、宽屏放开到后台设的百分比
  const contentMax = `max(1280px, ${config.pageWidth}%)`
  const [latencyChoice, setLatencyChoice] = useState<{ siteDefault: LatencyStyle; style: LatencyStyle } | null>(null)
  // 配置异步到达或默认档变化时，旧默认下的临时选择失效，所有延迟曲线一起跟随新默认
  const latencyStyle = latencyChoice?.siteDefault === config.latencyStyle ? latencyChoice.style : config.latencyStyle
  const chooseLatencyStyle = useCallback((next: LatencyStyle) => {
    setLatencyChoice(next === config.latencyStyle ? null : { siteDefault: config.latencyStyle, style: next })
  }, [config.latencyStyle])
  const latencyCurve = useMemo(() => ({
    style: latencyStyle,
    siteDefault: config.latencyStyle,
    onChange: chooseLatencyStyle,
  }), [latencyStyle, config.latencyStyle, chooseLatencyStyle])
  // 明暗：站长那一档（`themeMode`）当默认，访客点过顶栏那枚图标就以他的为准
  const [dark, toggleTheme] = useTheme(config.themeMode)
  // 顶栏那枚入口图标（1.25.0 起没有设置项）：挂载即探一次本站约定的 `/chicken/`，
  // 装了那座小鸡农场才出现、没装不占位（判据是内容而不是状态码，见 useLocalFarm）
  const farmUrl = useLocalFarm()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  const [route, go, goBilling] = useAppRoute()
  // 路由拆开用：open 喂给详情逻辑、showBilling 喂给账单页（两者互斥，由路由保证）
  const open = route.node
  const showBilling = route.billing
  // 列表的分组标签放在 App：进详情页再回来不丢
  const [group, setGroup] = useState<string | null>(null)
  // 地球侧栏里选中的地区：同理留在这儿
  const [region, setRegion] = useState<string | null>(null)
  // 访客自己的两个偏好（见 @/lib/theme-config）：地球看不看、卡片形态（后者没选过跟站长走）
  // ★ 站长那档是「节点地球」的**闸门**：他关掉时 `globeOn` 一律 false、顶栏开关也一起不挂
  const [globeOn, toggleGlobe] = useGlobeVisible(config.globeOn)
  // 异步站点配置也可能关闭地图；清除其筛选，避免没有取消入口或重新开启时复活旧地区
  if (!globeOn && region !== null) setRegion(null)
  const [cardStyle, chooseStyle] = useCardStyle(config.cardStyle)
  // 账单页是真路由（/billing，刷新存活、可分享）：开着才挂入口；「仅管理员」时
  // 还要站长登录（/api/me 的 authed）—— 没权限的人连按钮都不给，路由直达也是 404
  const billingVisible = config.billingOn && (config.billingAccess !== "admin" || !!me?.authed)
  // 列表页专属的顶栏控件只在真正的列表页挂：进了账单页（open 仍是 null）就收起
  const browsing = open === null && !showBilling
  // 顶栏搜索框：词与「窄屏那一行展开了没」都留在这儿 —— 进详情页再回来，搜到的还在
  const [query, setQuery] = useState("")
  // 搜索键盘导航：↑↓ 在**命中列表**里移动的那一格（下标，null = 没选）词一变就清零
  // （命中的那批换了，之前选到「第几台」已经没有意义）；显示时再按当前命中数夹一次
  const [cursor, setCursor] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  // 收起搜索（Esc 在空框上按的那一下） **不清词**：收起只是让出顶栏宽度，
  // 不是「别筛了」（收起态会看不见词，所以放大镜会提色、悬停带上词与命中数，见 SearchBox）
  const collapseSearch = () => setSearchOpen(false)
  // 窄屏那枚方形图标＝顶栏下面那一行的开关；桌面交给 CSS 的 :focus-within
  // matchMedia 只在事件里问一次，不为它挂订阅
  const onSearchActivate = () => {
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 639px)").matches
    setSearchOpen((was) => (narrow ? !was : false))
  }
  // 窄屏那一行收起：连词一起清 —— 收起后那一行看不见，留着词就成了看不见的筛选
  // （桌面收起态就是那枚图标，词留着有据可依）
  const closeSearchRow = () => {
    setSearchOpen(false)
    setQuery("")
    // 清词的同时把键盘光标也归零（见上面的 cursor）
    setCursor(null)
  }
  // 改词的同时把键盘光标归零：命中的那批换了，「第几台」已经没有意义
  const changeQuery = (next: string) => {
    setQuery(next)
    setCursor(null)
  }

  const loadMe = useCallback(() => {
    // `|| "..."`：api() 会回退到 statusText，而 HTTP/2/3 删掉了它 —— 无 body 的 502
    // 到达时是空串，不兜底就会被当没错误，重试按钮永远不渲染
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || "网络错误"))
  }, [])

  useEffect(() => {
    loadMe()
  }, [loadMe])

  /**
   * 图表 chunk 什么时候取，三条路谁先到听谁的：
   *   ① 开页就在详情页：立刻取；
   *   ② 列表画出来之后：交给浏览器挑空闲时机（别抢首批数据）；
   *   ③ 指针或键盘落到某张卡片上：立刻取
   * 代价：列表出来不到一秒就点开的那一下会看到骨架屏 —— 换来不点详情的访客不付这块带宽
   */
  const warmed = useRef(false)
  const warmDetail = useCallback(() => {
    warmed.current = true
    warmNodeDetail()
  }, [])
  const listReady = nodes !== null
  useEffect(() => {
    if (warmed.current) return
    if (open !== null) { warmDetail(); return }
    if (!listReady) return
    // 列表真的上屏之后才轮到这块 chunk：连等两帧再交给空闲回调
    // 标签页不在前台时 rAF 停住，切回来才补上
    let idle = 0
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        // Safari 到 18 才补上 requestIdleCallback：没有它就直接取
        if (typeof requestIdleCallback === "function") idle = requestIdleCallback(warmDetail, { timeout: 2000 })
        else warmDetail()
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      if (idle) cancelIdleCallback(idle)
    }
  }, [open, listReady, warmDetail])

  // 状态页在别的标签页里被关闭：`me` 还留着加载时的答案，重新查一次，
  // 让下面的 effect 把匿名访客送去面板，而不是留在一个不再更新的列表上
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  useEffect(() => {
    if (me && !me.public_page && !me.authed) location.href = "/admin/"
  }, [me])

  const sorted = [...(nodes ?? [])].sort((a, b) => a.sort - b.sort || a.id - b.id)
  const selected = sorted.find((n) => n.id === open)
  // 分组筛选只求值一次（@/lib/api 的 groupView）：概览卡片与下面的列表吃的是同一份
  // 「该显示哪几台」，切分组时两边一起变——参考站的内置 default 主题就是这个口径
  const view = groupView(sorted, group, hasGroupTabs(config.listTop))
  // 地区筛选叠在分组之上，两层是同一套「该显示哪几台」的延续：
  //   · 地球与右侧那列地区吃的是**当前分组**（`view.shown`）—— 与概览卡片同一口径，
  //     切分组时地球上的针与地区台数一起变；
  //   · 下面的列表再按地区收窄一层（`listView`）
  // 这样「上头写着 JP 4 台、下面只剩 2 张卡片」不会出现：地球是分组的地图，不是列表的地图
  const regions = regionView(view.shown, globeOn ? region : null)
  // 再叠一层搜索（口径见 @/lib/search）：这一层与地区筛选同一套——**下面那张列表与上面
  // 那行概览卡片一起收窄**，地球仍然是「分组的地图」（它画的是分组里有哪些地方，
  // 不是搜索结果热力图；地区列表点一行照样能把列表收窄到那个地区）
  const found = searchNodes(regions.shown, query)
  const listView = { ...view, shown: found.shown }

  // 搜索键盘导航（↑↓ 选、Enter 开）：下标是「命中列表里的第几台」，不变式与清零时机见 cursor 的声明处
  const moveCursor = (delta: 1 | -1) => {
    const count = found.shown.length
    if (count === 0) return
    setCursor((c) => (c === null ? (delta === 1 ? 0 : count - 1) : (c + delta + count) % count))
  }
  const enterCursor = () => {
    const node = cursor !== null ? found.shown[cursor] : undefined
    if (node) go(node.id)
  }
  // 显示时的当前选中：下标越界（命中数刚变过）就当作没选 —— 读的时候再夹一次，写的时候不用追
  const cursorId = cursor !== null && cursor < found.shown.length ? found.shown[cursor].id : null

  // `/node/{id}` 与 `/billing` 的标签页标题由这里独占（接管逻辑见模块级 ownTitle）
  useEffect(() => {
    if (!me) return
    ownTitle(showBilling ? "账单" : selected?.name, me.site_name || "Monitor")
  }, [selected?.name, me, showBilling])

  // 只在没有别的东西可展示时盖整页；`me` 到位后的失败应该落在页面旁边而不是顶上
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground">
      {meError ? <div className="space-y-3 text-center"><p role="alert">加载失败：{meError}</p><Button onClick={loadMe}>重试</Button></div> : "加载中…"}
    </div>
  )

  // 状态页关闭且未登录：跳去面板
  if (!me.public_page && !me.authed) return null

  return (
    // 纵向排下来、页脚吊在最后（main 吃满剩余高度）：机器少、内容比一屏短时，
    // 署名也落在屏幕的右下角，而不是紧贴在列表底下浮在半空中
    <LatencyStyleContext value={latencyCurve}>
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        {/* ★ 窄屏横向余量紧：按「站名优先展开、图标自己滑」分 —— 站名 max-w-[55%]、
            搜索钉右边，其余图标装进能横向滑动的条带（与分组标签行同一套做法：
            装不下就滑，不裁字、也不把整页撑宽） */}
        <div className="mx-auto flex w-full items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6" style={{ maxWidth: contentMax }}>
          {/* 站名就是回列表的路，节点页不需要自己的返回键；前面一枚站标领着 */}
          <button className="tap tap-8 flex max-w-[55%] shrink-0 items-center gap-2.5 font-semibold transition-opacity hover:opacity-70" onClick={() => go(null)}>
            <SiteIcon />
            <span className="truncate">{me.site_name || "Monitor"}</span>
          </button>
          <div className="flex-1" />
          {/* 搜索（名称 / 地区 / 系统）：只长在列表页 —— 它收窄的就是那张列表
              收起时是一枚方形图标，点开就地长成输入框（窄屏是顶栏下面多一行） */}
          {browsing && (
            <SearchBox
              value={query}
              onChange={changeQuery}
              onActivate={onSearchActivate}
              onClose={collapseSearch}
              hits={found.hit}
              onMove={moveCursor}
              onEnter={enterCursor}
            />
          )}
          {/* ★ 图标条带：装不下就**横向滑动**（与分组标签行同一套做法）
              py/px 给 .tap 那圈 ±6px 命中区留地方（被 overflow 裁掉就只剩 36）；
              横向**不加**负 margin（盒子会压到搜索格、吃掉它一半命中区）；
              间距固定 12px：两枚命中区各向外 6px，正好在缝里相接
              滑动条藏起来（见 index.css 的 .header-tools）：「还能滑」由露一半的图标提示 */}
          <div className="header-tools -my-1.5 flex min-w-0 items-center gap-3 overflow-x-auto px-1.5 py-1.5">
          {/* 面板是 hub 里的另一个应用，走导航而非路由只放图标、文案进 tooltip：
              这一行是图标条带，带字会把站名挤开 */}
          {/* 账单入口长在所有页面（列表 / 详情都能直接过去）；没权限（关了 / 仅管理员
              但没登录）整枚不挂，与地球开关同一口径 */}
          {billingVisible && (
            <Button
              variant={showBilling ? "secondary" : "ghost"}
              size="icon"
              aria-pressed={showBilling}
              onClick={() => goBilling(!showBilling)}
              title="账单"
              aria-label="账单"
            >
              <Wallet />
            </Button>
          )}
          <Button variant="ghost" size="icon" asChild>
            <a
              href="/admin/"
              title={me.authed ? "进入后台" : "登录"}
              aria-label={me.authed ? "进入后台" : "登录"}
            >
              <Wrench />
            </a>
          </Button>
          {/* 卡片形态：访客自己挑列表用哪种排法（只长在列表页 —— 它就只影响那一页） */}
          {browsing && (
            <CardStyleMenu value={cardStyle} siteDefault={config.cardStyle} onPick={chooseStyle} />
          )}
          {/* 地球开关：只长在列表页 ★ 站长关掉「节点地球」时**整枚按钮不挂**
              （不是藏／禁用）：关着的功能留按钮就是点了没反应的摆设 */}
          {browsing && config.globeOn && (
            <Button
              variant="ghost"
              size="icon"
              className="globe-toggle"
              aria-pressed={globeOn}
              onClick={() => {
                // ★关掉地球时**顺手清掉地区筛选**：那列地区长在地球里，地球一藏，
                // 「怎么取消」就没地方点了地区筛选本来就属于那张地图
                if (globeOn) setRegion(null)
                toggleGlobe()
              }}
              title={globeOn ? "隐藏节点地球" : "显示节点地球"}
              aria-label={globeOn ? "隐藏节点地球" : "显示节点地球"}
            >
              <GlobeIcon />
            </Button>
          )}
          {/* 入口图标：`/chicken/` 上真装了那座小鸡农场才出现（见 useLocalFarm） */}
          {farmUrl && (
            <Button variant="ghost" size="icon" asChild>
              <a href={farmUrl} title="养鸡场" aria-label="养鸡场">
                <FarmIcon />
              </a>
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题" aria-label="切换主题">
            {dark ? <Sun /> : <Moon />}
          </Button>
          </div>
        </div>
        {/* 窄屏搜索行：摆成 header 的直接子节点，跟着 sticky 块一起吸顶 */}
        {browsing && searchOpen && (
          <SearchRow value={query} onChange={changeQuery} onClose={closeSearchRow} onMove={moveCursor} onEnter={enterCursor} />
        )}
      </header>

      {/* ★ 内容宽度：1280 保底、宽屏放开到后台「内容宽度」设置（默认 85%，60–100 可调） —— header 与 footer 同此一条 */}
      <main className="mx-auto w-full flex-1 space-y-5 px-4 py-4 sm:px-6" style={{ maxWidth: contentMax }}>
        {error && <p className="text-sm text-destructive">{error}</p>}

        {showBilling ? (
          // 路由直达但没权限（billingOn 关了 / 仅管理员而没登录）：给一枚正经 404，
          // 不亮出内容也不假装是列表页
          billingVisible ? (
            <Billing nodes={nodes ?? []} exchangeRates={config.exchangeRates} excludeTag={config.billingExcludeOn ? config.billingExcludeTag : ""} />
          ) : (
            <div className="grid min-h-[60vh] place-items-center">
              <div className="space-y-3 text-center">
                <p className="text-4xl font-semibold tracking-tight">404</p>
                <p className="text-sm text-muted-foreground">账单页未开放或没有权限查看</p>
                <Button variant="outline" onClick={() => go(null)}>返回首页</Button>
              </div>
            </div>
          )
        ) : open !== null ? (
          !nodes ? (
            <DetailSkeleton />
          ) : selected ? (
            <Suspense fallback={<DetailSkeleton hasRemarks={hasDetailRemarks(selected, config.remarkPlacement)} />}>
              {/* 整页详情与紧凑展开里是同一个组件：保留天数也要一起给它，
                  否则「展开里有 30 天、点进去只有 7 天」会显得不一致 */}
              <DetailLoader node={selected} historyDays={me.history_days} remarkPlacement={config.remarkPlacement} onLoadFailureBack={() => go(null)} />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              节点不存在或未公开<button className="underline" onClick={() => go(null)}>返回列表</button>
            </p>
          )
        ) : !nodes ? (
          // 还在等节点列表：骨架按当前形态画 紧凑形态是一行一台，用几根细条比三张大卡片更像它
          cardStyle === "compact" ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : (
            // 骨架列数与真实网格同一套（见下面那张网格的注释），加载完成时不会跳列
            <div className={`grid gap-3 ${cardStyle === "detailed" || cardStyle === "detailedNoLatency" ? "grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]" : cardStyle === "wide" ? "grid-cols-[repeat(auto-fill,minmax(min(450px,100%),1fr))]" : "grid-cols-[repeat(auto-fill,minmax(min(264px,100%),1fr))]"}`}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-72" />
              ))}
            </div>
          )
        ) : (
          <>
            {/* 概览卡片行：设置里没选它时整个不挂载（不是藏起来），首屏与没有这个功能时一致
                「价值版」只是同一行换一副面孔，组件另收一个 finance 开关 */}
            {hasSummary(config.listTop) && <SummaryCards nodes={found.shown} finance={isBudgetLayout(config.listTop)} searching={found.active} exchangeRates={config.exchangeRates} excludeTag={config.billingExcludeOn ? config.billingExcludeTag : ""} onOpenBilling={billingVisible ? () => goBilling(true) : undefined} />}
            {/* 节点地球：概览卡片之下、列表之上（上游就是这个次序） */}
            {globeOn && (
              <Globe nodes={view.shown} dark={dark} region={regions.current} onRegion={setRegion} onOpen={go} onWarm={warmDetail} />
            )}
            {/* 一台都剩不下时说清楚是谁筛没的、去哪儿取消 —— 否则一片空白像站点坏了
                搜索那一层排在前面：它是访客刚动手的那层 */}
            {found.active && found.shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                当前筛选下没有匹配「{found.query.trim()}」的节点 —— 名称、备注、地区、系统都能搜
                （用 | 隔开表示「或」，空格按整体短语匹配）；点搜索框里那枚 × 清掉
              </p>
            ) : globeOn && regions.shown.length === 0 && view.shown.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                这个地区里当前没有节点 —— 点上面那一列的「全部」取消筛选
              </p>
            ) : null}
            <NodeList view={listView} group={group} onGroup={setGroup} onOpen={go} onWarm={warmDetail}
              latencyLines={config.pingLines}
              cardStyle={cardStyle}
              historyDays={me.history_days}
              remarkPlacement={config.remarkPlacement}
              terms={found.terms}
              cursorId={cursorId} />
          </>
        )}
      </main>

      {/* 页脚署名：一行浅色小字居中，链接新标签页打开（地址见 REPO_URL / ENGINE_URL） */}
      <footer className="mx-auto w-full border-t px-4 pb-5 pt-4 sm:px-6" style={{ maxWidth: contentMax }}>
        <p className="theme-credit text-center">
          Powered by{" "}
          <a href={ENGINE_URL} target="_blank" rel="noreferrer">
            Monitor
          </a>
          {" | Theme by "}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Casurea
          </a>
        </p>
      </footer>
    </div>
    </LatencyStyleContext>
  )
}

/** 顶栏的圆形站标：优先取 /favicon.ico（上传站点图标后由 hub 在此返回，保留透明背景）；
 *  apple-touch-icon 那份按 iOS 规范垫了不透明底色，只在 ico 拿不到时兜底；都取不到就不占位 */
function SiteIcon() {
  const [src, setSrc] = useState(() => document.querySelector('link[rel~="icon"]')?.getAttribute("href") || "/favicon.ico")
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <span className="size-8 shrink-0 overflow-hidden rounded-full ring-1 ring-border/60">
      <img
        src={src}
        alt=""
        className="size-full object-cover"
        onError={() => (src !== "/apple-touch-icon.png" ? setSrc("/apple-touch-icon.png") : setBroken(true))}
      />
    </span>
  )
}

// 列表**分批挂载**：首屏挂 100 张卡片的长任务才是真开销（稳态重渲染接近免费），
// 先画一屏、剩下的每帧补 12 张（短于长任务线），不做虚拟滚动
function useProgressive(total: number, first = 24, step = 12): number {
  const [limit, setLimit] = useState(() => Math.min(total, first))
  // 换了筛选/搜索（total 变了），列表换了，重新从第一批开始 —— 渲染期直接比，不放进 effect
  // （effect 里同步 setState 会白白多跑一轮渲染）
  const [seenTotal, setSeenTotal] = useState(total)
  if (seenTotal !== total) {
    setSeenTotal(total)
    setLimit(Math.min(total, first))
  }
  useEffect(() => {
    if (limit >= total) return
    const timer = setTimeout(() => setLimit((n) => Math.min(total, n + step)), 0)
    return () => clearTimeout(timer)
  }, [limit, total, step])
  return limit
}

function NodeList({ view, group, onGroup, onOpen, onWarm, latencyLines, cardStyle, historyDays, remarkPlacement, terms, cursorId }: {
  /** 分组求值的结果：groups / current / shown / tabs / total（App 与概览卡片共用一份） */
  view: ReturnType<typeof groupView>
  /** 原始选中值（null = 全部，"" = 未分组）：只在归一化后回写时用，见下面的 effect */
  group: string | null
  onGroup: (group: string | null) => void
  onOpen: (id: number) => void
  /** 指针/键盘刚落到某一张卡片上：把详情那块 chunk 先取回来（见 App 的 warmDetail） */
  onWarm: () => void
  /** 卡片延迟块要显示哪几条线路（ping 任务名，换行分隔）；空串 = 自动 */
  latencyLines: string
  /** 卡片形态：compact = 一行一台的表格；detailed = 在延迟形态上再加在线时长与元信息；detailedNoLatency = 与 detailed 相同但不含三网延迟；wide = 横向宽卡、列数随网格自适应；latency 网络单行 + 延迟；classic 网络两行、无延迟；plain 与 classic 版式相同、只换一套视觉处理 */
  cardStyle: "classic" | "latency" | "detailed" | "detailedNoLatency" | "wide" | "plain" | "compact"
  /** hub 的历史保留天数：透给「紧凑」形态展开行里那块详情图（时间范围那排按钮按它生成） */
  historyDays?: number
  /** 主题设置里的「备注显示位置」：卡片那一侧要不要摊备注（见 @/lib/site-settings） */
  remarkPlacement: RemarkPlacement
  /** 搜索命中词：名字里命中的片段描色（见 TextHighlight）；没在搜时是空数组 */
  terms: string[]
  /** 搜索键盘光标（↑↓）停在哪台上：对应卡片描边 / 行铺底色，并滚进视野 */
  cursorId: number | null
}) {
  const { groups, current, shown, tabs, total, showTabs } = view
  // 首屏先画一屏的量，剩下的分帧补上（见 useProgressive）
  const list = shown.slice(0, useProgressive(shown.length))
  // 归一化后的值回写给 App（悬空的选中态被回落时纠正一次，见 groupView 的注释）
  useEffect(() => {
    if (current !== group) onGroup(current)
  }, [current, group, onGroup])
  // 键盘光标挪出屏幕时把它滚回来：卡片与紧凑行都挂了 data-node-card，一个选择器通吃
  useEffect(() => {
    if (cursorId === null) return
    document.querySelector(`[data-node-card="${cursorId}"]`)?.scrollIntoView({ block: "nearest" })
  }, [cursorId])
  return (
    <>
      {/* 分组标签行是列表的筛选条 */}
      {showTabs && groups.length > 0 && (
        <div role="group" aria-label="分组" className="-mx-1 -mt-2 mb-3 flex gap-1 overflow-x-auto px-1 pb-1">
          {tabs.map(([value, label, count]) => (
            <Button
              // 分组名是自由文本，key 带前缀免得与「全部」撞
              key={value === null ? "*" : `=${value}`}
              aria-pressed={current === value}
              size="sm"
              variant={current === value ? "secondary" : "ghost"}
              className="shrink-0"
              onClick={() => onGroup(value)}
            >
              {label}
              <span className="tnum text-muted-foreground">{count}</span>
            </Button>
          ))}
        </div>
      )}
      {total === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">还没有节点</p>
      ) : cardStyle === "compact" ? (
        <CompactList nodes={list} onOpen={onOpen} onWarm={onWarm} historyDays={historyDays} remarkPlacement={remarkPlacement} terms={terms} cursorId={cursorId} />
      ) : (
        // 列数自适应（auto-fill + minmax），不再按断点写死：容器多宽就排多少列——宽屏
        // 内容宽度（默认 85%）接管后自动排到 5、6 列，卡片宽度始终夹在下限与均分之间 下限按形态分：
        // 详细两档内容密，320px（1230px 容器仍是 3 列）；其余四档 264px（仍是 4 列）
        // `min(下限,100%)` 兜住 320px 老手机：窄屏退成单列而不是横向溢出
        <div data-card-style={cardStyle} className={`grid items-start gap-3 ${cardStyle === "detailed" || cardStyle === "detailedNoLatency" ? "grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]" : cardStyle === "wide" ? "grid-cols-[repeat(auto-fill,minmax(min(450px,100%),1fr))]" : "grid-cols-[repeat(auto-fill,minmax(min(264px,100%),1fr))]"}`}>
          {list.map((n) => (
            <NodeCard key={n.id} node={n} onOpen={() => onOpen(n.id)} onWarm={onWarm} latencyLines={latencyLines} cardStyle={cardStyle} remarkPlacement={remarkPlacement} terms={terms} selected={n.id === cursorId} />
          ))}
        </div>
      )}
    </>
  )
}
