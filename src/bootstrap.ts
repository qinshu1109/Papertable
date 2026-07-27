import "./styles/base.css";

/**
 * 桌面 WebView 里，模块初始化异常通常只会落在原生控制台，用户看到的却是一片
 * 白屏。把启动器和实际 React 应用拆开：即使后者的任何依赖加载失败，至少也给出
 * 可读的诊断，而不是假装应用已经打开。
 */
function errorText(cause: unknown) {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  return "启动阶段发生了未知错误。";
}

/**
 * 不能静态 import `@tauri-apps/api`：恰恰是在它或主模块加载失败时仍然要能报错。
 * Tauri 注入的低层调用足够把一条受限长度的诊断写回本机；网页端没有该对象，会
 * 自然跳过。
 */
function reportDesktopStartupFailure(message: string) {
  type TauriInternals = {
    invoke?: (
      command: string,
      payload: Record<string, string>,
    ) => Promise<unknown>;
  };
  const internals = (
    window as Window & { __TAURI_INTERNALS__?: TauriInternals }
  ).__TAURI_INTERNALS__;
  void internals
    ?.invoke?.("report_frontend_startup_failure", {
      message: message.slice(0, 4_000),
    })
    .catch(() => undefined);
}

function showStartupFailure(cause: unknown) {
  const message = errorText(cause);
  reportDesktopStartupFailure(message);
  const root = document.getElementById("root");
  if (!root || root.dataset.startupFailure === "true") return;
  root.dataset.startupFailure = "true";
  root.replaceChildren();

  const shell = document.createElement("main");
  shell.className = "startup-failure";
  const title = document.createElement("h1");
  title.textContent = "Papertable 没能正常启动";
  const body = document.createElement("p");
  body.textContent = "本地数据没有被修改。请复制下面的错误信息反馈给开发者。";
  const detail = document.createElement("pre");
  detail.textContent = message;
  shell.append(title, body, detail);
  root.append(shell);

  // 保留给 Web Inspector 和系统日志，不把堆栈直接展示在界面中。
  console.error("Papertable startup failure", cause);
}

window.addEventListener("error", (event) => showStartupFailure(event.error));
window.addEventListener("unhandledrejection", (event) =>
  showStartupFailure(event.reason),
);

void import("./main").catch(showStartupFailure);
