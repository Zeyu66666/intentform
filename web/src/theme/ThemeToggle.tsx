/**
 * 全站唯一的主题开关（省赛附加 A-19）。
 *
 * 位置固定在右上角：五个页面各自页头结构不同，把开关塞进每个页头等于五处维护、
 * 五处可能漏；固定定位只写一次，且打印时被 `.no-print` 隐藏。
 *
 * 触控目标 44×44（`min-h-[44px] min-w-[44px]`），与全站其它按钮同一条规矩。
 */

import { preferenceLabel } from "./model";
import { useTheme } from "./useTheme";

export interface ThemeToggleProps {
  /**
   * `fixed`：匿名页/学生页没有统一顶栏，固定在右上角；
   * `inline`：教师端已登录顶栏，按钮跟着身份区排，避免压在退出按钮上。
   */
  readonly variant?: "fixed" | "inline";
}

const FIXED_CLASS =
  "no-print fixed right-2 top-2 z-10 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-line bg-surface px-2 text-sm text-muted shadow-sm hover:border-accent hover:text-accent";
const INLINE_CLASS =
  "no-print flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm border border-line bg-surface px-2 text-sm text-muted hover:border-accent hover:text-accent";

export function ThemeToggle({ variant = "fixed" }: ThemeToggleProps = {}): JSX.Element {
  const { preference, resolved, cycle } = useTheme();
  const label = preferenceLabel(preference);

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      data-theme-preference={preference}
      data-theme-resolved={resolved}
      aria-label={label}
      title={label}
      onClick={cycle}
      className={variant === "fixed" ? FIXED_CLASS : INLINE_CLASS}
    >
      {/* 图标与文字都随偏好变化：只给图标会让「现在是什么主题」靠猜。 */}
      <span aria-hidden="true" className="text-base">
        {preference === "dark" ? "☾" : preference === "light" ? "☀" : "◐"}
      </span>
      <span className="ml-1 hidden sm:inline">{preference === "system" ? "跟随系统" : preference === "light" ? "浅色" : "深色"}</span>
    </button>
  );
}
