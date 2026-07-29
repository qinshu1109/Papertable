import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, BookOpen, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import {
  buildVerdictLedger,
  type VerdictLedgerEntry,
  type VerdictList,
  verdicts,
} from "../lib/verdicts";

type LoadState =
  | { status: "loading" }
  | { status: "available"; list: VerdictList }
  | { status: "unavailable"; message: string };

function VerdictEntry({ entry }: { entry: VerdictLedgerEntry }) {
  return (
    <article className="verdict-entry">
      <div className="verdict-entry-head">
        <span className={`verdict-kind ${entry.verdict.verdictType}`}>
          {entry.verdict.verdictType === "gold" ? "金子" : "墓碑"}
        </span>
        <span className="verdict-reuse">复用 {entry.reuseCount} 次</span>
      </div>
      <p>{entry.verdict.content}</p>
      {entry.verdict.concepts.length > 0 && (
        <div className="verdict-concepts" aria-label="概念把手">
          {entry.verdict.concepts.map((concept) => (
            <span key={concept}>{concept}</span>
          ))}
        </div>
      )}
      {entry.superseded.length > 0 && (
        <details className="verdict-history">
          <summary>查看已替代版本（{entry.superseded.length}）</summary>
          {entry.superseded.map((old) => (
            <div key={old.verdict.id} className="verdict-old">
              <p>{old.verdict.content}</p>
              <span>复用 {old.reuseCount} 次</span>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}

export function VerdictLedger({ onContinue }: { onContinue: () => void }) {
  const { activeProjectId, cards, projects } = useStore();
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const projectName =
    projects.find((project) => project.id === activeProjectId)?.name ??
    "当前项目";

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void verdicts.list(activeProjectId).then((response) => {
      if (!current) return;
      setState(
        response.available
          ? { status: "available", list: response.data }
          : { status: "unavailable", message: response.error.message },
      );
    });
    return () => {
      current = false;
    };
  }, [activeProjectId, reload]);

  const retry = useCallback(() => setReload((value) => value + 1), []);
  const ledger = useMemo(
    () =>
      state.status === "available"
        ? buildVerdictLedger(activeProjectId, state.list, cards)
        : null,
    [activeProjectId, cards, state],
  );

  return (
    <section className="verdict-ledger scroll-y" aria-labelledby="ledger-title">
      <div className="verdict-ledger-inner">
        <header className="verdict-ledger-head">
          <div>
            <span className="verdict-ledger-kicker">{projectName}</span>
            <h1 id="ledger-title">判决簿</h1>
            <p>这里只列 MemOS 中当前项目的有效判决。</p>
          </div>
          <button className="continue-exploration" onClick={onContinue}>
            继续上次探索
            <ArrowRight size={15} />
          </button>
        </header>

        {state.status === "loading" && (
          <div className="verdict-ledger-state" role="status">
            <BookOpen size={20} />
            正在读取 MemOS 真值…
          </div>
        )}

        {state.status === "unavailable" && (
          <div className="verdict-ledger-state unavailable" role="alert">
            <AlertTriangle size={20} />
            <strong>判决簿当前不可用</strong>
            <span>{state.message} 本地卡片不会被当作判决真值。</span>
            <button onClick={retry}>
              <RefreshCw size={14} />
              重试
            </button>
          </div>
        )}

        {ledger && (
          <>
            <div className="verdict-groups">
              <section aria-labelledby="gold-title">
                <h2 id="gold-title">金子</h2>
                {ledger.gold.length ? (
                  ledger.gold.map((entry) => (
                    <VerdictEntry key={entry.verdict.id} entry={entry} />
                  ))
                ) : (
                  <p className="verdict-empty">还没有金子。</p>
                )}
              </section>
              <section aria-labelledby="tombstone-title">
                <h2 id="tombstone-title">墓碑</h2>
                {ledger.tombstones.length ? (
                  ledger.tombstones.map((entry) => (
                    <VerdictEntry key={entry.verdict.id} entry={entry} />
                  ))
                ) : (
                  <p className="verdict-empty">还没有墓碑。</p>
                )}
              </section>
            </div>
            <p className="verdict-reuse-note">
              复用次数只来自本地 verdictTrace 审计，不会写回判决内容。
            </p>
          </>
        )}

        <details className="exploration-fold">
          <summary>探索树与旧卡片（已折叠）</summary>
          <p>旧探索数据仍完整保留，需要时可回到上次卡片继续。</p>
          <button onClick={onContinue}>进入原工作台</button>
        </details>
      </div>
    </section>
  );
}
