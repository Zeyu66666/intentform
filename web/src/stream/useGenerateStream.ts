/**
 * 把"一条 SSE 字节流"接进 React 状态：`useReducer` + `AbortController`。
 *
 * 为什么不用 `EventSource`：`/api/generate` 是 **POST**（要带 `{ requirement }` 请求体），
 * `EventSource` 只支持 GET、无法自定义请求头、也无法读取非 2xx 的响应体。
 * 所以流式读取在 `stream/source.ts` 里手写（`fetch` → `body.getReader()` →
 * `TextDecoder({stream:true})`），这里只负责把**文本块**交给帧解析器，再按 `seq` 投递。
 *
 * 三条硬要求（对应计划 §4.1 I3）：
 * 1. **可取消**：`cancel()` → `controller.abort()` → 上游 `reader.read()` 抛 AbortError →
 *    `stream/source.ts` 的 `finally` 释放 reader。任意阶段都能取消。
 * 2. **不重复发请求**：`start()` 先 abort 上一轮再换 `runId`；`React.StrictMode`
 *    双挂载时 effect 的清理只会 abort 已发起的请求，不会自己再发一次。
 * 3. **不泄漏**：卸载时递增 `runId` 并 abort，之后迟到的 chunk 一律丢弃。
 * 4. **缺号不会把界面钉死**：流式期间按 `GAP_TICK_MS` 定时派发 `{ type: "tick", now }`，
 *    由 reducer 判断"缺口等了多久"。reducer 保持纯函数（不读时钟、不排定时器），
 *    时间只能从动作里进去——这样 `generate-machine.test.ts` 能精确控制等待时长。
 */

import { useCallback, useEffect, useReducer, useRef } from "react";

import type { Clarification, FormBlueprint } from "@intentform/schema";

import { createSseFrameParser, type ParsedFrame } from "./frames";
import {
  GAP_TICK_MS,
  generateReducer,
  initialGenerateState,
  type GenerateState,
} from "./generate-machine";
import { GenerateStreamError, isAbortError, type StreamSource } from "./source";

export interface UseGenerateStreamResult {
  readonly state: GenerateState;
  /** `clarifications` 是澄清补答（R-05）；空数组时请求体与以前逐字节相同。 */
  readonly start: (
    requirement: string,
    clarifications?: readonly Clarification[],
    blueprint?: FormBlueprint,
    kind?: "quiz" | "survey",
  ) => void;
  readonly cancel: () => void;
  readonly reset: () => void;
}

export function useGenerateStream(source: StreamSource): UseGenerateStreamResult {
  const [state, dispatch] = useReducer(generateReducer, initialGenerateState);

  /** 当前这一轮的令牌：只有仍等于它的异步回调才允许 dispatch。 */
  const runIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // 卸载（含 StrictMode 的第一次假卸载）时中断在途请求并让迟到的回调失效。
    return () => {
      runIdRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    // 只在流式期间排定时器；清理函数一定清掉，StrictMode 双挂载也不会留下两个 interval。
    if (state.status !== "streaming") return undefined;
    const timer = setInterval(() => {
      dispatch({ type: "tick", now: Date.now() });
    }, GAP_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [state.status]);

  const applyFrame = useCallback((frame: ParsedFrame): void => {
    if (frame.kind === "event") {
      dispatch({ type: "event", event: frame.event });
      return;
    }
    if (frame.kind === "malformed") {
      // 坏帧不打断整条流：记一条异常，界面上能看到"这一帧挂了"，其余照常渲染。
      dispatch({ type: "malformed", reason: frame.reason });
    }
    // heartbeat：按契约它根本不是事件，不产生状态变化。
  }, []);

  const start = useCallback(
    (
      requirement: string,
      clarifications: readonly Clarification[] = [],
      blueprint?: FormBlueprint,
      kind?: "quiz" | "survey",
    ): void => {
      const trimmed = requirement.trim();
      if (trimmed === "") return;

      // 上一轮还在跑就先掐掉，避免两条流同时往一个 reducer 里灌事件。
      controllerRef.current?.abort();

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const controller = new AbortController();
      controllerRef.current = controller;

      dispatch({ type: "start" });

      const pump = async (): Promise<void> => {
        const parser = createSseFrameParser();
        try {
          for await (const chunk of source({
            requirement: trimmed,
            clarifications,
            ...(blueprint === undefined ? {} : { blueprint }),
            ...(kind === undefined ? {} : { kind }),
            signal: controller.signal,
          })) {
            if (runId !== runIdRef.current) return;
            for (const frame of parser.push(chunk)) applyFrame(frame);
          }
          if (runId !== runIdRef.current) return;
          for (const frame of parser.flush()) applyFrame(frame);
          // 流结束却没有终态事件：这条链路不算成功，必须明确报错，
          // 否则界面会永远停在"生成中"（比报错更难排查）。
          dispatch({
            type: "fail",
            code: "internal",
            message: "生成链路在收到 done/error 之前就结束了（终态事件缺失）",
          });
        } catch (error) {
          if (runId !== runIdRef.current) return;
          if (isAbortError(error)) {
            dispatch({ type: "cancel" });
            return;
          }
          if (error instanceof GenerateStreamError) {
            dispatch({ type: "fail", code: error.code, message: error.message });
            return;
          }
          dispatch({
            type: "fail",
            code: "internal",
            message: error instanceof Error ? error.message : "未知的传输错误",
          });
        }
      };

      void pump();
    },
    [applyFrame, source],
  );

  const cancel = useCallback((): void => {
    // 先 abort 再 dispatch：abort 会让 pump 的 catch 也走 cancel，
    // reducer 里的 cancel 对已取消状态是幂等的，两条路径不会打架。
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "cancel" });
  }, []);

  const reset = useCallback((): void => {
    runIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "reset" });
  }, []);

  return { state, start, cancel, reset };
}
