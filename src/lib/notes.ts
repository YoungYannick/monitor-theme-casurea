// 相对路径 import 照 `src/lib` 的惯例（`globe.ts` → `./world.ts`）：单测用 Node 直接跑，认不了 `@/` 别名
import { remarksOnDetail, type RemarkPlacement } from "./site-settings.ts"

/**
 * 节点备注：hub 后台按节点填的两个字段，随 `/api/nodes` 一起下发；**卡片与详情页显示的是合并后的
 * 一份**（私有在前、公有在后，见 `remarkChips`） 主题设置里没有备注设置项
 *
 *   · **公开备注**（`public_remark`）——站长写给访客的一行说明：单行、≤100 字、留空就是没写；
 *     hub 存的时候就 trim 过，换行与控制字符直接拒收 它随**公开视图**下发，匿名也拿得到；
 *     老 hub 没有这个字段，按「这台没写备注」处理
 *   · **私有备注**（`remark`）——站长写给自己的，**只在登录态下发**，匿名视图里没有这个键
 *     hub 对它不做长度与控制字符校验，历史数据与接口写入都可能带换行
 *
 * **两边的写法一致**：逗号与分号（均含半角 / 全角）分隔＝多枚小卡片；私有那条多一手
 * 「按换行也拆」（hub 对它没有单行约束）
 *
 * 放在这里（而不是组件里）是因为它们是纯函数：能脱开 React 单测，改起来不怕漏
 */
export function publicRemark(node: { public_remark?: string | null }): string {
  // 再削一次空白：「只有空白」应当与「没写」等价，否则会渲染出一个空的备注位
  return (node.public_remark ?? "").trim()
}

/** 备注值 → 小卡片列表：逗号与分号（均含半角 / 全角）分隔，削首尾空白、丢掉空片段 */
export function splitTags(value: string): string[] {
  return value
    .split(/[,，;；]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

/** hub 那条公开备注 → 一枚枚小卡片 */
export function hubTags(node: { public_remark?: string | null }): string[] {
  return splitTags(publicRemark(node))
}

/** 私有备注 → 一枚枚小卡片：**先按换行分段、段内再按逗号 / 分号拆**（hub 对它没有单行约束） */
export function ownTags(node: { remark?: string | null }): string[] {
  return (node.remark ?? "")
    .split(/\r?\n/)
    .flatMap((line) => splitTags(line))
}

/** 一枚备注小卡片：`own` 为真 = 私有（仅自己可见，版式层用描边 + 锁图标标出来） */
export type RemarkChip = { text: string; own: boolean }

/**
 * 卡片与详情页共用的那一份备注：**私有在前、公有在后**，都拆成一枚枚小卡片
 * hub 只把私有备注下发给**登录的管理员**，所以同一个函数在访客那边拿到的就只有公有那几枚——
 * 不需要两套分支，也不会漏泄 两个字段都没有（或只有空白）→ 空数组，页面上一个像素都不占
 */
export function remarkChips(node: { public_remark?: string | null; remark?: string | null }): RemarkChip[] {
  const own = ownTags(node).map((text) => ({ text, own: true }))
  const pub = hubTags(node).map((text) => ({ text, own: false }))
  return [...own, ...pub]
}

/**
 * 详情页那一块会不会占位：**这台机器有备注** 且 站长把备注摊在详情页（`remarksOnDetail`）
 * 两处共用，免得各写一遍：`NodeDetail` 决定画不画那一行小卡片；`DetailSkeleton`（`src/App.tsx`）
 * 决定骨架里给不给它留位 —— 漏了它整页点开时会「先塌再撑」
 */
export function hasDetailRemarks(
  node: { public_remark?: string | null; remark?: string | null },
  placement: RemarkPlacement,
): boolean {
  return remarksOnDetail(placement) && remarkChips(node).length > 0
}
