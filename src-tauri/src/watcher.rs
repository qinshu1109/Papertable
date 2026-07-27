//! vault 监听。入向**只新增 `ReferenceChip`**，永不改动 `Card`/`Turn`/`CardEdge`。
//!
//! 那是整件事可控的关键：`ReferenceChip` 是纯增量的，所以入向完全不需要冲突解决。
//! 把 Obsidian 的编辑回流进 `Turn.content` 是另一回事，见 `docs/VAULT_SYNC.md` 的
//! 「推迟」一节。
//!
//! ## 环路防护要三层，缺一不可
//!
//! 1. **归一化哈希比对** —— 唯一*正确*的一层，与时序无关。事件对应的文件归一化后
//!    等于索引里记的值，就是我们自己写入的回声。
//! 2. **在途抑制集**，3 秒 TTL。**不能作为唯一机制**：macOS FSEvents 是延迟批处理
//!    且目录粒度的，事件会迟到、会合并，纯抑制窗口在负载下会丢掉真实的用户编辑。
//! 3. **逐路径 500 ms 防抖** —— 编辑器保存是多次系统调用；Obsidian 保存之后紧跟
//!    Linter 的 `lintOnSave` 重写，是毫秒级的两次独立写入。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// 在途抑制的存活时间。超过它就只信哈希——FSEvents 迟到得比这更久是常态。
pub const INFLIGHT_TTL: Duration = Duration::from_secs(3);
/// 逐路径防抖窗口。
pub const DEBOUNCE: Duration = Duration::from_millis(500);

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexedNote {
    /// vault 相对路径。
    pub path: String,
    /// 文件名去掉 `.md`，也就是 `[[双链]]` 里写的那个名字。
    pub name: String,
    /// frontmatter 里的 `papertable_id`；不是我们写的笔记就是 None。
    pub note_id: Option<String>,
    pub hash: String,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Verdict {
    /// 不该看的文件。
    Ignore,
    /// 我们自己写入的回声，丢弃。
    OurEcho,
    /// 真实的外部变化，更新索引并通知前端。
    Adopt,
}

/// 该不该看这个路径。
///
/// 排除任何以 `.` 开头的路径分量：`.obsidian/`、`.trash/`、`.DS_Store`。这个 vault
/// 几乎每个目录都有 `.DS_Store`，而 Obsidian 在不停重写 `.obsidian/workspace.json`
/// ——不排除的话监听器会被它们淹没。
pub fn should_watch(relative: &Path) -> bool {
    let mut has_component = false;
    for component in relative.components() {
        let Some(text) = component.as_os_str().to_str() else {
            return false;
        };
        if text.starts_with('.') {
            return false;
        }
        has_component = true;
    }
    has_component
        && relative
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Papertable 自己写入的容纳子树不能再作为资料入库，否则“导出→监听→检索→再导出”
/// 会把模型自己的旧回答当作证据。这个判断独立于隐藏目录规则，方便自定义容纳根。
fn is_excluded(relative: &Path, excluded: Option<&Path>) -> bool {
    excluded.is_some_and(|prefix| relative.starts_with(prefix))
}

/// 事件分类。**纯函数**：三层防护的判定逻辑全在这里，这样它能被测到，而不用去
/// 驱动一个真实的文件系统监听器。
pub fn verdict(
    relative: &Path,
    inflight: bool,
    disk_hash: Option<&str>,
    indexed_hash: Option<&str>,
) -> Verdict {
    if !should_watch(relative) {
        return Verdict::Ignore;
    }
    match (disk_hash, indexed_hash) {
        // 文件没了：索引里有就要清掉，算一次真实变化。
        (None, Some(_)) => Verdict::Adopt,
        (None, None) => Verdict::Ignore,
        (Some(disk), Some(indexed)) if disk == indexed => Verdict::OurEcho,
        // 哈希对不上。在途抑制只是省一次读盘的优化，走到这里说明内容确实变了，
        // 无论抑制窗口开着与否都要采纳——否则 FSEvents 迟到就会吞掉真实编辑。
        _ => {
            let _ = inflight;
            Verdict::Adopt
        }
    }
}

/// 从 frontmatter 里读 `papertable_id`。
///
/// 重命名必须按它匹配，**不能按路径**：macOS FSEvents 是目录粒度的，一次重命名会
/// 表现为两个不相关路径的 create + delete。
pub fn note_id_of(markdown: &str) -> Option<String> {
    let rest = markdown.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    rest[..end].lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "papertable_id").then(|| value.trim().trim_matches('"').to_string())
    })
}

/// `[[双链]]` 里写的那个名字。
pub fn note_name(relative: &Path) -> String {
    relative
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// 逐路径防抖。事件先攒着，安静满 `DEBOUNCE` 才算真正落定。
#[derive(Default)]
pub struct Debouncer {
    pending: HashMap<PathBuf, Instant>,
}

impl Debouncer {
    pub fn touch(&mut self, path: PathBuf, now: Instant) {
        self.pending.insert(path, now);
    }

    /// 取出已经安静下来的路径。
    pub fn drain_settled(&mut self, now: Instant) -> Vec<PathBuf> {
        let settled: Vec<PathBuf> = self
            .pending
            .iter()
            .filter(|(_, seen)| now.duration_since(**seen) >= DEBOUNCE)
            .map(|(path, _)| path.clone())
            .collect();
        for path in &settled {
            self.pending.remove(path);
        }
        settled
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
}

/// 在途抑制集：写盘前登记，事件到达或超过 TTL 后清除。
#[derive(Default)]
pub struct Inflight {
    marks: HashMap<PathBuf, Instant>,
}

impl Inflight {
    pub fn mark(&mut self, path: PathBuf, now: Instant) {
        self.marks.insert(path, now);
    }

    /// 查询并顺手清掉过期项。
    pub fn take(&mut self, path: &Path, now: Instant) -> bool {
        self.marks
            .retain(|_, at| now.duration_since(*at) < INFLIGHT_TTL);
        self.marks.remove(path).is_some()
    }
}

// ---------------------------------------------------------------------------
// 实际的监听线程
// ---------------------------------------------------------------------------

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::Connection;
use std::sync::{mpsc, Arc, Mutex};

/// 采纳一个已落定的路径：更新索引，返回给前端的描述。
/// 文件不在了就从索引里删掉，返回 None。
fn adopt(conn: &Connection, root: &Path, relative: &Path, now: i64) -> Option<IndexedNote> {
    let key = relative.to_string_lossy().to_string();
    let full = root.join(relative);
    let Ok(text) = std::fs::read_to_string(&full) else {
        let _ = crate::db::drop_indexed(conn, &key);
        // 资料库存在时，同步删除对应 chunk；旧 vault_index 语义不受影响。
        let _ = crate::notes::remove_vault_file(conn, root, relative);
        return None;
    };
    let hash = crate::vault::normalized_hash(&text);
    let name = note_name(relative);
    let note_id = note_id_of(&text);
    let _ = crate::db::put_indexed(conn, &key, &name, note_id.as_deref(), &hash, now);
    // NoteLibrary 还没连接时这是 no-op；连接后 watcher 是桌面端的增量语料来源。
    let _ = crate::notes::index_vault_file(conn, root, relative, &text, now);
    Some(IndexedNote {
        path: key,
        name,
        note_id,
        hash,
    })
}

/// 处理一批已落定的路径，返回真正被采纳的那些。
/// 三层防护的最终裁决在 `verdict()` 里，这里只负责取数据。
pub fn process_settled(
    conn: &Connection,
    root: &Path,
    settled: &[PathBuf],
    inflight: &mut Inflight,
    now_instant: Instant,
    now: i64,
) -> Vec<IndexedNote> {
    let mut adopted = Vec::new();
    for relative in settled {
        let key = relative.to_string_lossy().to_string();
        let disk_hash = std::fs::read_to_string(root.join(relative))
            .ok()
            .map(|text| crate::vault::normalized_hash(&text));
        let indexed = crate::db::indexed_hash(conn, &key).ok().flatten();
        let marked = inflight.take(relative, now_instant);
        match verdict(relative, marked, disk_hash.as_deref(), indexed.as_deref()) {
            Verdict::Ignore | Verdict::OurEcho => continue,
            Verdict::Adopt => {
                if let Some(note) = adopt(conn, root, relative, now) {
                    adopted.push(note);
                } else {
                    adopted.push(IndexedNote {
                        path: key,
                        name: note_name(relative),
                        note_id: None,
                        hash: String::new(),
                    });
                }
            }
        }
    }
    adopted
}

/// 全量重扫。监听器出问题时的手动兜底，也是首次开启同步时建立索引的方式。
pub fn scan(conn: &Connection, root: &Path, now: i64) -> std::io::Result<usize> {
    scan_excluding(
        conn,
        root,
        Some(Path::new(crate::vault::DEFAULT_SUBTREE)),
        now,
    )
}

pub fn scan_excluding(
    conn: &Connection,
    root: &Path,
    excluded: Option<&Path>,
    now: i64,
) -> std::io::Result<usize> {
    // 与 start() 用同一套解析后的根，否则扫描出来的相对路径和监听事件的相对路径
    // 对不上，同一篇笔记会在索引里存成两条。
    let root = &root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    // 保留既有 Vault 监听入口，但它现在也建立一个独立的只读资料库。资料不会成为
    // Card；是否能被某个项目检索仍要显式绑定。
    let library = crate::notes::connect_vault(conn, root, Some(now))
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut alive = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            // 不进以 . 开头的目录：.obsidian 里有成千上万个文件。
            e.depth() == 0
                || !e
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with('.'))
        })
        .filter_map(std::result::Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(relative) = entry.path().strip_prefix(root) else {
            continue;
        };
        if !should_watch(relative) || is_excluded(relative, excluded) {
            continue;
        }
        if adopt(conn, root, relative, now).is_some() {
            alive.push(relative.to_string_lossy().to_string());
        }
    }
    // 监听器会处理运行期的删除；这里补上应用关闭期间发生的删除，避免已经从
    // Vault 消失的笔记仍被资料库检索到。只影响当前 root 对应的只读资料库。
    crate::notes::retain_vault_documents(conn, &library.id, &alive)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let _ = crate::db::retain_indexed(conn, &alive);
    Ok(alive.len())
}

pub struct VaultWatcher {
    pub inflight: Arc<Mutex<Inflight>>,
    handle: Mutex<Option<RecommendedWatcher>>,
}

impl Default for VaultWatcher {
    fn default() -> Self {
        Self {
            inflight: Arc::new(Mutex::new(Inflight::default())),
            handle: Mutex::new(None),
        }
    }
}

impl VaultWatcher {
    /// 写盘前登记，让常见路径省掉一次读盘。**它只是优化**——真正的判定靠哈希。
    pub fn mark(&self, relative: &Path) {
        if let Ok(mut guard) = self.inflight.lock() {
            guard.mark(relative.to_path_buf(), Instant::now());
        }
    }

    /// 开始监听。重复调用会先停掉上一个；`excluded` 是 Papertable 写入子树，
    /// 永远不应重新成为只读检索资料。
    pub fn start_excluding<F>(
        &self,
        root: PathBuf,
        db: Arc<Mutex<Connection>>,
        excluded: Option<PathBuf>,
        emit: F,
    ) -> notify::Result<()>
    where
        F: Fn(Vec<IndexedNote>) + Send + 'static,
    {
        // **必须先 canonicalize。** FSEvents 上报的是解析过符号链接的真实路径，
        // 而 macOS 上 /tmp 就是 /private/tmp 的符号链接；拿未解析的根去
        // strip_prefix 会对每一个事件都失配，于是监听器一声不响地什么都不做。
        let root = root.canonicalize().unwrap_or(root);
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = tx.send(event);
        })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;

        let inflight = Arc::clone(&self.inflight);
        std::thread::spawn(move || {
            let mut debouncer = Debouncer::default();
            loop {
                // 有事件就收，没有就每 100 ms 醒一次去看防抖窗口有没有到期。
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(Ok(event)) => {
                        for path in event.paths {
                            if let Ok(relative) = path.strip_prefix(&root) {
                                if should_watch(relative)
                                    && !is_excluded(relative, excluded.as_deref())
                                {
                                    debouncer.touch(relative.to_path_buf(), Instant::now());
                                }
                            }
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
                if debouncer.is_empty() {
                    continue;
                }
                let settled = debouncer.drain_settled(Instant::now());
                if settled.is_empty() {
                    continue;
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or_default();
                let adopted = {
                    let Ok(conn) = db.lock() else { break };
                    let Ok(mut marks) = inflight.lock() else {
                        break;
                    };
                    process_settled(&conn, &root, &settled, &mut marks, Instant::now(), now)
                };
                if !adopted.is_empty() {
                    emit(adopted);
                }
            }
        });

        *self.handle.lock().expect("watcher lock") = Some(watcher);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn only_markdown_outside_dot_directories_is_watched() {
        assert!(should_watch(&p("项目/笔记.md")));
        assert!(should_watch(&p("笔记.MD")));
        // 这个 vault 几乎每个目录都有 .DS_Store，Obsidian 还在不停重写
        // .obsidian/workspace.json——不排除的话监听器会被它们淹没。
        assert!(!should_watch(&p(".obsidian/workspace.json")));
        assert!(!should_watch(&p("项目/.DS_Store")));
        assert!(!should_watch(&p(".trash/删掉的.md")));
        assert!(!should_watch(&p("项目/图.canvas")));
        assert!(!should_watch(&p("")));
    }

    #[test]
    fn papertable_owned_output_is_excluded_from_read_only_sources() {
        let owned = p("80_AI暂存/Papertable/项目/卡片.md");
        assert!(is_excluded(
            &owned,
            Some(Path::new(crate::vault::DEFAULT_SUBTREE))
        ));
        assert!(!is_excluded(
            &p("10_活跃知识/真实资料.md"),
            Some(Path::new(crate::vault::DEFAULT_SUBTREE))
        ));
    }

    #[test]
    fn our_own_write_is_recognised_by_hash_not_by_timing() {
        // 抑制窗口已经关闭（迟到的 FSEvents），但哈希一致——仍然是我们的回声。
        assert_eq!(
            verdict(&p("a.md"), false, Some("h1"), Some("h1")),
            Verdict::OurEcho,
        );
    }

    /// 抑制窗口开着，但内容确实变了：必须采纳。
    /// 纯抑制窗口的设计会在这里丢掉真实的用户编辑。
    #[test]
    fn a_real_edit_inside_the_suppression_window_is_still_adopted() {
        assert_eq!(
            verdict(&p("a.md"), true, Some("h2"), Some("h1")),
            Verdict::Adopt,
        );
    }

    #[test]
    fn a_new_file_and_a_deleted_file_are_both_real_changes() {
        assert_eq!(verdict(&p("a.md"), false, Some("h1"), None), Verdict::Adopt);
        assert_eq!(verdict(&p("a.md"), false, None, Some("h1")), Verdict::Adopt);
        assert_eq!(verdict(&p("a.md"), false, None, None), Verdict::Ignore);
    }

    #[test]
    fn ignored_paths_never_reach_the_hash_comparison() {
        assert_eq!(
            verdict(&p(".obsidian/workspace.json"), false, Some("x"), None),
            Verdict::Ignore,
        );
    }

    #[test]
    fn renames_are_matched_by_frontmatter_id_not_by_path() {
        let note = "---\npapertable_id: c-wave\npapertable_project: p\n---\n\n# 波函数\n";
        assert_eq!(note_id_of(note).as_deref(), Some("c-wave"));
        assert_eq!(note_id_of("# 没有 frontmatter\n"), None);
        // 别人写的笔记没有这个键。
        assert_eq!(note_id_of("---\ntitle: 我的笔记\n---\n\n正文\n"), None);
        assert_eq!(note_name(&p("项目/量子退相干.md")), "量子退相干");
    }

    #[test]
    fn a_save_followed_by_a_linter_rewrite_collapses_into_one_change() {
        let mut debouncer = Debouncer::default();
        let start = Instant::now();
        // Obsidian 保存，紧接着 Linter 的 lintOnSave 重写：毫秒级的两次写入。
        debouncer.touch(p("a.md"), start);
        debouncer.touch(p("a.md"), start + Duration::from_millis(20));
        assert!(debouncer
            .drain_settled(start + Duration::from_millis(300))
            .is_empty());
        assert_eq!(
            debouncer.drain_settled(start + Duration::from_millis(600)),
            vec![p("a.md")],
        );
        assert!(debouncer.is_empty(), "落定之后不该再重复上报");
    }

    #[test]
    fn inflight_marks_expire_so_a_late_event_is_not_swallowed_forever() {
        let mut inflight = Inflight::default();
        let start = Instant::now();
        inflight.mark(p("a.md"), start);
        assert!(inflight.take(&p("a.md"), start + Duration::from_millis(100)));
        // 取过就没了。
        assert!(!inflight.take(&p("a.md"), start + Duration::from_millis(150)));

        inflight.mark(p("b.md"), start);
        assert!(
            !inflight.take(&p("b.md"), start + INFLIGHT_TTL + Duration::from_millis(1)),
            "过期的抑制标记不能继续吞事件",
        );
    }
}
