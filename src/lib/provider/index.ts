/**
 * 模型通道的选择点，与 `lib/storage` 同一个模式。
 *
 * web 端走本机 Node 服务的 `/api/…`；桌面端走 Tauri 命令，因为打包后的应用里没有
 * 那个 HTTP 服务。两边的语义（任务白名单、目标地址由后端持有、推理与正文分道）
 * 必须一致，各自有测试守着。
 *
 * `store.tsx` 和 `ConceptPreview.tsx` 从这里具名引入，换目标时它们一行都不用改。
 */
import * as http from "./http";
import * as tauri from "./tauri";

export type { ModelTask, ProviderConfig, ProviderHealth } from "./http";

const impl = __PAPERTABLE_TARGET__ === "desktop" ? tauri : http;

export const getProviderHealth = impl.getProviderHealth;
export const getProviderConfig = impl.getProviderConfig;
export const saveProviderConfig = impl.saveProviderConfig;
export const streamModel = impl.streamModel;
export const generateModel = impl.generateModel;
