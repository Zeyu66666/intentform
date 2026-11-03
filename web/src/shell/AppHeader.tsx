/**
 * 教师端顶栏：品牌、两处主入口、身份与退出。
 *
 * 只放「一眼要找到的东西」：生成表单、我的表单、当前账号、退出。
 * 具体操作（编辑、发布、批改）留在各自页面里，不把顶栏做成第二套导航。
 */

import type { TeacherIdentity } from "@intentform/schema";

import { Link } from "../Link";
import { DASHBOARD_PATH, SETTINGS_PATH } from "../router";
import { ThemeToggle } from "../theme/ThemeToggle";

export interface AppHeaderProps {
  readonly teacher: TeacherIdentity;
  readonly pathname: string;
  readonly busy: boolean;
  readonly onLogout: () => void;
}

function tabClass(active: boolean): string {
  return active
    ? "rounded-sm bg-accent px-3 py-2 text-sm font-medium text-white"
    : "rounded-sm px-3 py-2 text-sm text-ink hover:bg-bg";
}

export function AppHeader({ teacher, pathname, busy, onLogout }: AppHeaderProps): JSX.Element {
  const onGenerate = pathname === "/";
  const onDashboard = pathname.startsWith(DASHBOARD_PATH);
  return (
    <header className="no-print border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-2 py-2">
        <Link href="/" className="mr-2 text-lg font-semibold tracking-tight text-ink">
          意卷
        </Link>
        <nav aria-label="主导航" className="flex items-center gap-1">
          <Link href="/" className={tabClass(onGenerate)}>
            生成表单
          </Link>
          <Link href={DASHBOARD_PATH} className={tabClass(onDashboard)}>
            我的表单
          </Link>
          <Link href={SETTINGS_PATH} className={tabClass(pathname.startsWith(SETTINGS_PATH))}>
            模型设置
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted sm:inline" data-testid="auth-email">
            {teacher.email}
          </span>
          <ThemeToggle variant="inline" />
          <button
            type="button"
            data-testid="logout"
            className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-muted hover:border-accent hover:text-accent disabled:opacity-50"
            disabled={busy}
            onClick={onLogout}
          >
            退出
          </button>
        </div>
      </div>
    </header>
  );
}
