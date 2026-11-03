/**
 * 站内链接。
 *
 * 为什么要一个组件：手写 `<a href="/dashboard">` 会触发整页刷新（丢掉生成页里
 * 正在流式的状态），而只用 `onClick` + `pushState` 又丢掉了中键新开标签、右键复制
 * 地址、以及"这是链接"的可访问语义。两者都要：`href` 给浏览器，`onClick` 里
 * 只接管"普通左键"这一种情况。
 */

import { navigate } from "./useRoute";

export interface LinkProps {
  readonly href: string;
  readonly children: React.ReactNode;
  readonly className?: string;
  /** 可访问名与测试钩子：矩阵单元格需要「为某知识点补一道某层级题」的完整语义。 */
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
}

export function Link({
  href,
  children,
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: LinkProps): JSX.Element {
  return (
    <a
      href={href}
      {...(className === undefined ? {} : { className })}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      onClick={(event) => {
        // 修饰键 / 非左键 / 已被处理的点击：交给浏览器（新标签、下载、外部协议）。
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
