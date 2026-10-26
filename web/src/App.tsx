/**
 * 应用外壳。I3 阶段由 `web-streaming` 用三栏生成页（左输入 / 中预览 / 右时间线）替换本文件。
 * 这里先放一个能跑起来的最小壳，只为了让 `pnpm --filter @intentform/web build`
 * 在工具链接入的那一刻就是绿的——否则"骨架完成"这句话没有可验证的证据。
 */
export function App(): JSX.Element {
  return (
    <main className="flex h-full items-center justify-center p-4">
      <section className="max-w-[640px] rounded-md border border-line bg-surface p-6">
        <h1 className="text-xl">意卷 IntentForm</h1>
        <p className="mt-2 text-sm text-muted">
          前端工具链已就绪（React 18 + Vite 5 + Tailwind 3）。生成页正在建设中。
        </p>
      </section>
    </main>
  );
}
