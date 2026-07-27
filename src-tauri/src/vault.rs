//! Obsidian vault 写入器。规格见 `docs/VAULT_SYNC.md`。
//!
//! 两条不可让步的规则：
//!
//! 1. **容纳**：只写 `<vault>/80_AI暂存/Papertable/` 这一个子树。所有写路径经过
//!    唯一一个 `resolve()`，canonicalize 之后断言前缀。没有第二条写路径。
//!    vault 的 `AGENTS.md` 是用户自己写的治理契约，写错地方是信任层面的事件。
//!
//! 2. **不覆盖用户的编辑**：文件内容与我们上次写入的归一化哈希不符，就说明用户在
//!    Obsidian 改过它。不覆盖、不合并，写到 `.papertable-conflict.md` 并挂起同步。
//!    任何合并启发式最终都会吃掉用户写的一段。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Papertable 在知识库里拥有的子树，**默认值**。
///
/// 可以由设置改成别的相对路径（见 `AppSettings.vaultSubtree`），但**永远只有一个根**，
/// 而且容纳断言一个字不改。可配置的是落点，不是要不要检查。
///
/// 不提供「关掉检查」或「允许多个根」：这条断言是路径构造出 bug 与用户知识库之间
/// 唯一的东西，它的价值来自不可协商。一旦出现 `if consented { skip }`，它就退化成注释。
/// 另外，写进 `10_活跃知识` / `20_项目` 会绕过用户自己 AGENTS.md 规定的
/// knowledge-coach preview→publish→verify 流程——那是流程问题，不是权限问题。
pub const DEFAULT_SUBTREE: &str = "80_AI暂存/Papertable";

/// 校验一个子树相对路径能否作为容纳根。
///
/// 拒绝绝对路径、`..`、空分量，以及以 `.` 开头的分量（`.obsidian` 之类是应用元数据，
/// 绝不能作为写入根）。
/// 归一化并校验来自前端的子树。
///
/// 空值回落到 `DEFAULT_SUBTREE`：**Rust 是默认值的权威**。前端漏传时应当落到正确的
/// 子树，而不是落到知识库根目录——那会把笔记直接铺在 `10_活跃知识` 的旁边。
pub fn subtree_or_default(subtree: &str) -> Result<String> {
    let trimmed = subtree.trim();
    let chosen = if trimmed.is_empty() {
        DEFAULT_SUBTREE
    } else {
        trimmed
    };
    validate_subtree(chosen)?;
    Ok(chosen.to_string())
}

pub fn validate_subtree(subtree: &str) -> Result<Vec<String>> {
    // 绝对路径必须**报错**，不能靠「过滤掉前导空分量」把它悄悄变成相对路径——
    // 粘贴 `/Users/…/别处` 的人会得到一个被默默改过的落点，而不是一个错误。
    if subtree.starts_with('/') || subtree.starts_with('\\') {
        return Err(format!("子树必须是相对路径：{subtree}").into());
    }
    if Path::new(subtree).is_absolute() {
        return Err(format!("子树必须是相对路径：{subtree}").into());
    }
    let parts: Vec<&str> = subtree
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("子树路径不能为空".into());
    }
    for part in &parts {
        if *part == ".." || part.starts_with('.') || part.contains(':') {
            return Err(format!("子树路径分量不被允许：{part}").into());
        }
        if Path::new(part).components().count() != 1 {
            return Err(format!("子树路径分量不被允许：{part}").into());
        }
    }
    Ok(parts.iter().map(|s| s.to_string()).collect())
}

#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(v: std::io::Error) -> Self {
        Error(v.to_string())
    }
}
impl From<String> for Error {
    fn from(v: String) -> Self {
        Error(v)
    }
}
impl From<&str> for Error {
    fn from(v: &str) -> Self {
        Error(v.to_string())
    }
}
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Papertable 拥有的根目录。
pub fn root_of(vault: &Path, subtree: &str) -> PathBuf {
    let mut path = vault.to_path_buf();
    for part in subtree.split('/').filter(|s| !s.is_empty()) {
        path.push(part);
    }
    path
}

/// 默认子树下的根目录。只有测试用；生产路径一律显式传 subtree。
#[cfg(test)]
pub fn root(vault: &Path) -> PathBuf {
    root_of(vault, DEFAULT_SUBTREE)
}

/// **唯一的写路径解析入口。**
///
/// 拒绝 `..`、绝对路径分量、以及任何 canonicalize 之后落在根之外的目标（符号链接
/// 逃逸就靠这一步）。目标尚不存在时逐级向上找已存在的祖先来 canonicalize，
/// 因为 `canonicalize` 要求路径真实存在。
#[cfg(test)]
pub fn resolve(vault: &Path, relative: &[&str]) -> Result<PathBuf> {
    resolve_in(vault, DEFAULT_SUBTREE, relative)
}

/// **唯一的写路径解析入口**（带显式子树）。
pub fn resolve_in(vault: &Path, subtree: &str, relative: &[&str]) -> Result<PathBuf> {
    validate_subtree(subtree)?;
    let root = root_of(vault, subtree);
    let mut target = root.clone();
    for part in relative {
        if part.is_empty() {
            return Err("路径分量不能为空".into());
        }
        let candidate = Path::new(part);
        for component in candidate.components() {
            match component {
                Component::Normal(_) => {}
                _ => return Err(format!("路径分量不被允许：{part}").into()),
            }
        }
        target.push(candidate);
    }

    let anchor = existing_ancestor(&target);
    let real_anchor = anchor.canonicalize()?;
    let real_root = match root.canonicalize() {
        Ok(path) => path,
        // 根还不存在：它一定在 vault 之内，用 vault 的真实路径重建。
        Err(_) => {
            let mut path = vault.canonicalize()?;
            for part in subtree.split('/').filter(|s| !s.is_empty()) {
                path.push(part);
            }
            path
        }
    };
    // 用已解析的祖先重建完整路径，避免路径里残留未解析的符号链接。
    //
    // 目标本身就是那个已存在的祖先时，suffix 为空——**必须直接返回 real_anchor**。
    // `join("")` 会留下一个尾斜杠，而对普通文件 stat("/a/b/") 在 macOS 上返回
    // ENOTDIR，于是 `.exists()` 对每个已存在的文件都答 false：冲突检测永远不会
    // 触发，用户的编辑会被静默覆盖。
    let suffix = target
        .strip_prefix(&anchor)
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let full = if suffix.as_os_str().is_empty() {
        real_anchor
    } else {
        real_anchor.join(suffix)
    };

    // 断言的对象必须是**解析后的完整路径**，不是那个已存在的祖先。容纳根首次创建
    // 之前，最深的已存在祖先在根的*上面*（例如 80_AI暂存），拿它去比前缀会把每一次
    // 合法的首次写入都拒掉。
    if full != real_root && !full.starts_with(&real_root) {
        return Err(format!("拒绝写到容纳目录之外：{}", target.display()).into());
    }
    Ok(full)
}

fn existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path;
    loop {
        if current.exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => return PathBuf::from("/"),
        }
    }
}

// ---------------------------------------------------------------------------
// 归一化哈希
// ---------------------------------------------------------------------------

/// vault 开着 obsidian-linter 的 `lintOnSave`，用户每次保存都会按字母序重排
/// frontmatter、剔除尾空白、折叠连续空行。**字节级哈希会在每次保存时误报冲突**，
/// 哪怕用户什么都没改。所以归一化是硬需求，不是优化。
pub fn normalized_hash(markdown: &str) -> String {
    let (frontmatter, body) = split_frontmatter(markdown);
    let mut keys: Vec<&str> = frontmatter
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .collect();
    keys.sort_unstable();

    let mut normalized_body = String::new();
    let mut blank_run = 0usize;
    for line in body.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        normalized_body.push_str(trimmed);
        normalized_body.push('\n');
    }

    let mut hasher = Sha256::new();
    hasher.update(keys.join("\n").as_bytes());
    hasher.update(b"\n \n");
    hasher.update(normalized_body.trim().as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn split_frontmatter(markdown: &str) -> (&str, &str) {
    let Some(rest) = markdown.strip_prefix("---\n") else {
        return ("", markdown);
    };
    match rest.find("\n---\n") {
        Some(index) => (&rest[..index], &rest[index + 5..]),
        None => ("", markdown),
    }
}

// ---------------------------------------------------------------------------
// 写入与冲突
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum WriteOutcome {
    /// 文件不存在，新建。
    Created,
    /// 是我们上次写的、没人动过，放心覆盖。
    Updated,
    /// 内容与上次写入一致，什么都没做。
    Unchanged,
    /// 用户在 Obsidian 改过它。已写入 .papertable-conflict.md，同步挂起。
    Conflict,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub outcome: WriteOutcome,
    /// 写入后应记入 sync_state 的哈希；冲突时是 None（不推进基线）。
    pub hash: Option<String>,
    /// vault 相对路径，用于 UI 上点名文件。
    pub path: String,
    pub conflict_path: Option<String>,
}

/// 用户对冲突的决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overwrite {
    /// 常规：覆盖前检查用户有没有改过这个文件。
    IfUnchanged,
    /// 用户选了「以 Papertable 为准」。**一次性**无条件覆盖，并清掉冲突副本。
    ///
    /// 必须是一个明确的意图，不能用「把基线置空」来表达——那正好落进
    /// 「无基线 + 文件已存在 → 隔离」这条防止接管他人文件的规则里，于是
    /// 按钮点了、提示说会覆盖、下一次同步却又报冲突。
    Force,
}

/// 按容纳规则写一篇笔记，并在覆盖前检查用户有没有改过它。
///
/// `last_written_hash` 来自 sync_state：`None` 表示我们从没写过这个文件。
pub fn write_note(
    vault: &Path,
    subtree: &str,
    relative: &[&str],
    content: &str,
    last_written_hash: Option<&str>,
    overwrite: Overwrite,
) -> Result<WriteReport> {
    let path = resolve_in(vault, subtree, relative)?;
    let display = relative.join("/");
    let next_hash = normalized_hash(content);

    if overwrite == Overwrite::Force {
        write_atomically(&path, content)?;
        // 用户已经选定以 Papertable 为准，留着冲突副本只会让人以为还没解决。
        let conflict = path.with_extension("papertable-conflict.md");
        if conflict.exists() {
            let _ = std::fs::remove_file(conflict);
        }
        return Ok(WriteReport {
            outcome: WriteOutcome::Updated,
            hash: Some(next_hash),
            path: display,
            conflict_path: None,
        });
    }

    if path.exists() {
        let existing = std::fs::read_to_string(&path)?;
        let existing_hash = normalized_hash(&existing);
        match last_written_hash {
            // 从没写过、但文件已经在那里：这是用户或别的工具的文件，绝不接管。
            None => return quarantine(&path, content, &display, next_hash),
            Some(previous) if previous != existing_hash => {
                return quarantine(&path, content, &display, next_hash)
            }
            Some(_) if existing_hash == next_hash => {
                return Ok(WriteReport {
                    outcome: WriteOutcome::Unchanged,
                    hash: Some(next_hash),
                    path: display,
                    conflict_path: None,
                })
            }
            Some(_) => {
                write_atomically(&path, content)?;
                return Ok(WriteReport {
                    outcome: WriteOutcome::Updated,
                    hash: Some(next_hash),
                    path: display,
                    conflict_path: None,
                });
            }
        }
    }

    write_atomically(&path, content)?;
    Ok(WriteReport {
        outcome: WriteOutcome::Created,
        hash: Some(next_hash),
        path: display,
        conflict_path: None,
    })
}

fn quarantine(
    path: &Path,
    content: &str,
    display: &str,
    _next_hash: String,
) -> Result<WriteReport> {
    let conflict = path.with_extension("papertable-conflict.md");
    write_atomically(&conflict, content)?;
    Ok(WriteReport {
        outcome: WriteOutcome::Conflict,
        // 基线**不推进**：这篇卡片的同步就此挂起，直到用户二选一。
        hash: None,
        path: display.to_string(),
        conflict_path: Some(
            conflict
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
    })
}

/// **每一次真实的磁盘写入都记一笔。**
///
/// 验收时把 `.obsidian/workspace.json` 被 Obsidian 自己改写算成了 Papertable 的红线
/// 事故——那是判据的问题：真实库是个活的 Obsidian vault，有自己的记账行为，靠比对
/// 整库 mtime 无法归因。这份日志让「Papertable 写了哪些路径」可以被直接读出来，
/// 不需要推断。写在应用数据目录，不在知识库里。
static WRITE_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record_write(path: &Path) {
    if let Ok(mut log) = WRITE_LOG.lock() {
        log.push(path.display().to_string());
        // 只保留最近的窗口；这是审计线索，不是持久档案。
        let len = log.len();
        if len > 500 {
            log.drain(..len - 500);
        }
    }
}

/// Papertable 到目前为止真正写过的路径。
pub fn written_paths() -> Vec<String> {
    WRITE_LOG.lock().map(|log| log.clone()).unwrap_or_default()
}

fn write_atomically(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("papertable-tmp");
    std::fs::write(&temp, content)?;
    std::fs::rename(&temp, path)?;
    record_write(path);
    Ok(())
}

/// 标题变更走 rename 而不是删+建，这样 Obsidian 会自动更新指向它的 `[[双链]]`。
pub fn rename_note(vault: &Path, subtree: &str, from: &[&str], to: &[&str]) -> Result<()> {
    let source = resolve_in(vault, subtree, from)?;
    let target = resolve_in(vault, subtree, to)?;
    if !source.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&source, &target)?;
    record_write(&target);
    Ok(())
}

/// 删掉某篇笔记旁边的 `.papertable-conflict.md`（若有）。
///
/// 三个时机都要清：强制覆盖后（决定已做出）、「保留笔记」后（用户拒绝了这份内容）、
/// 重命名时（副本挂在旧文件名上，否则永远躺在知识库里像一个没解决的冲突）。
pub fn remove_conflict_copy(vault: &Path, subtree: &str, relative: &[&str]) -> Result<()> {
    let path = resolve_in(vault, subtree, relative)?;
    let conflict = path.with_extension("papertable-conflict.md");
    if conflict.exists() {
        std::fs::remove_file(conflict)?;
    }
    Ok(())
}

pub fn delete_note(vault: &Path, subtree: &str, relative: &[&str]) -> Result<()> {
    let path = resolve_in(vault, subtree, relative)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
        record_write(&path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 常规写入，测试里的默认。
    fn write_note_default(
        vault: &Path,
        relative: &[&str],
        content: &str,
        last: Option<&str>,
    ) -> Result<WriteReport> {
        write_note(
            vault,
            DEFAULT_SUBTREE,
            relative,
            content,
            last,
            Overwrite::IfUnchanged,
        )
    }

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(root(dir.path())).unwrap();
        dir
    }

    /// 首次同步时 `80_AI暂存/Papertable/` 还不存在，最深的已存在祖先在根的*上面*。
    /// 上面所有测试都预先建好了根，因此漏掉了这条最常见的路径——真机上第一次开启
    /// 同步时它一个文件也写不出来，而且不报错。
    #[test]
    fn the_first_write_creates_the_root_instead_of_being_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("80_AI暂存")).unwrap();
        let report = write_note_default(dir.path(), &["项目", "首篇.md"], "# 首篇\n", None)
            .expect("容纳根尚不存在时，首次写入必须成功并把它建出来");
        assert_eq!(report.outcome, WriteOutcome::Created);
        assert!(root(dir.path()).join("项目/首篇.md").exists());
    }

    /// vault 本身就不存在时应当报错，而不是在别处凭空造一棵树。
    #[test]
    fn a_missing_vault_is_an_error() {
        assert!(resolve(Path::new("/nonexistent-vault-xyz"), &["a.md"]).is_err());
    }

    #[test]
    fn writes_land_inside_the_owned_subtree() {
        let dir = vault();
        let report =
            write_note_default(dir.path(), &["项目", "卡片.md"], "# 内容\n", None).unwrap();
        assert_eq!(report.outcome, WriteOutcome::Created);
        assert!(root(dir.path()).join("项目/卡片.md").exists());
    }

    /// 红线：任何一次落在容纳目录之外都必须失败，而不是「顺手写了」。
    #[test]
    fn escaping_the_subtree_is_refused() {
        let dir = vault();
        for escape in [
            vec!["..", "逃逸.md"],
            vec!["..", "..", "10_活跃知识", "覆盖.md"],
            vec!["/etc/passwd"],
            vec!["项目/../../../外面.md"],
        ] {
            assert!(
                resolve(dir.path(), &escape).is_err(),
                "应当拒绝：{escape:?}"
            );
        }
        // 确认没有任何东西被写出去。
        assert!(!dir.path().join("逃逸.md").exists());
        assert!(!dir.path().join("10_活跃知识").exists());
    }

    #[test]
    fn a_symlink_out_of_the_subtree_is_refused() {
        let dir = vault();
        let outside = dir.path().join("10_活跃知识");
        fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root(dir.path()).join("链接")).unwrap();
        assert!(
            resolve(dir.path(), &["链接", "正式知识.md"]).is_err(),
            "符号链接逃逸必须被 canonicalize 拦下"
        );
    }

    /// Linter 每次保存都会重排 frontmatter。字节哈希会因此在每次保存时误报冲突。
    #[test]
    fn the_hash_survives_a_linter_reformat() {
        let original = "---\nb_key: 2\na_key: 1\n---\n\n# 标题\n\n正文。\n";
        let linted = "---\na_key: 1\nb_key: 2\n---\n\n# 标题   \n\n\n\n正文。\n";
        assert_ne!(original, linted, "两者字节确实不同");
        assert_eq!(
            normalized_hash(original),
            normalized_hash(linted),
            "归一化后必须相同，否则每次保存都误报冲突"
        );
    }

    #[test]
    fn a_real_edit_still_changes_the_hash() {
        let a = "---\nk: 1\n---\n\n正文。\n";
        let b = "---\nk: 1\n---\n\n正文，被改过。\n";
        assert_ne!(normalized_hash(a), normalized_hash(b));
    }

    #[test]
    fn a_user_edit_is_quarantined_never_overwritten() {
        let dir = vault();
        let path = ["项目", "卡片.md"];
        let first =
            write_note_default(dir.path(), &path, "---\nk: 1\n---\n\n原始正文。\n", None).unwrap();
        let hash = first.hash.unwrap();

        // 用户在 Obsidian 改了它。
        let file = root(dir.path()).join("项目/卡片.md");
        fs::write(&file, "---\nk: 1\n---\n\n我自己改的正文。\n").unwrap();

        let report = write_note_default(
            dir.path(),
            &path,
            "---\nk: 1\n---\n\nPapertable 的新正文。\n",
            Some(&hash),
        )
        .unwrap();

        assert_eq!(report.outcome, WriteOutcome::Conflict);
        assert!(report.hash.is_none(), "冲突时不得推进基线");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "---\nk: 1\n---\n\n我自己改的正文。\n",
            "用户的编辑必须逐字节保留"
        );
        assert!(root(dir.path())
            .join("项目/卡片.papertable-conflict.md")
            .exists());
    }

    /// 只保存、没改内容（Linter 重排了 frontmatter）不该被当成冲突。
    #[test]
    fn a_pure_linter_reformat_is_not_a_conflict() {
        let dir = vault();
        let path = ["项目", "卡片.md"];
        let content = "---\nb: 2\na: 1\n---\n\n正文。\n";
        let hash = write_note_default(dir.path(), &path, content, None)
            .unwrap()
            .hash
            .unwrap();

        // Obsidian 保存 → Linter 重排键、加了空行。
        fs::write(
            root(dir.path()).join("项目/卡片.md"),
            "---\na: 1\nb: 2\n---\n\n正文。\n\n\n",
        )
        .unwrap();

        let report = write_note_default(dir.path(), &path, content, Some(&hash)).unwrap();
        assert_eq!(
            report.outcome,
            WriteOutcome::Unchanged,
            "纯 Linter 重排必须被识别为无变化"
        );
    }

    #[test]
    fn a_pre_existing_file_we_never_wrote_is_never_taken_over() {
        let dir = vault();
        let file = root(dir.path()).join("项目/别人的笔记.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "不是 Papertable 写的。\n").unwrap();

        let report = write_note_default(
            dir.path(),
            &["项目", "别人的笔记.md"],
            "Papertable 想写的内容。\n",
            None,
        )
        .unwrap();
        assert_eq!(report.outcome, WriteOutcome::Conflict);
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "不是 Papertable 写的。\n"
        );
    }

    /// 「以 Papertable 为准」必须真的覆盖。
    ///
    /// 真机验收在这里失败过：当时把这个意图表达成「把 last_written_hash 置空」，
    /// 而那正好落进「无基线 + 文件已存在 → 隔离」这条规则，于是按钮点了、提示说会
    /// 覆盖、下一次同步照旧报冲突，用户的编辑还在。
    #[test]
    fn choosing_papertable_actually_overwrites() {
        let dir = vault();
        let path = ["项目", "卡片.md"];
        let hash = write_note_default(dir.path(), &path, "---\nk: 1\n---\n\n原始。\n", None)
            .unwrap()
            .hash
            .unwrap();

        let file = root(dir.path()).join("项目/卡片.md");
        fs::write(&file, "---\nk: 1\n---\n\n我自己改的。\n").unwrap();
        // 先走一次常规同步，确认它被隔离（这一步是失败前提）。
        let conflicted = write_note_default(dir.path(), &path, "新内容。\n", Some(&hash)).unwrap();
        assert_eq!(conflicted.outcome, WriteOutcome::Conflict);
        assert!(root(dir.path())
            .join("项目/卡片.papertable-conflict.md")
            .exists());

        // 用户选择以 Papertable 为准。
        let forced = write_note(
            dir.path(),
            DEFAULT_SUBTREE,
            &path,
            "Papertable 的新内容。\n",
            None, // 基线为空也不该阻止强制覆盖
            Overwrite::Force,
        )
        .unwrap();
        assert_eq!(forced.outcome, WriteOutcome::Updated);
        assert!(forced.hash.is_some(), "强制覆盖后要推进基线");
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "Papertable 的新内容。\n",
            "文件必须真的被覆盖"
        );
        assert!(
            !root(dir.path())
                .join("项目/卡片.papertable-conflict.md")
                .exists(),
            "决定已经做出，冲突副本要清掉，否则看起来像还没解决"
        );
    }

    /// 落点可配置，但校验不可协商。
    #[test]
    /// 前端漏传 subtree 时，落点必须回落到默认子树，**不能**变成知识库根目录——
    /// 那会把笔记直接铺在 `10_活跃知识` 旁边。
    fn a_missing_subtree_falls_back_to_the_default_not_the_vault_root() {
        for blank in ["", "   ", "\n"] {
            assert_eq!(subtree_or_default(blank).unwrap(), DEFAULT_SUBTREE);
        }
        assert_eq!(subtree_or_default("  探索/PT  ").unwrap(), "探索/PT");
        // 回落不会顺带放过非法值。
        assert!(subtree_or_default("../外面").is_err());
        assert!(subtree_or_default("/Users/qinshu/别处").is_err());
        assert!(subtree_or_default(".obsidian").is_err());
    }

    #[test]
    fn a_configurable_subtree_is_still_validated() {
        assert!(validate_subtree("80_AI暂存/Papertable").is_ok());
        assert!(validate_subtree("探索/Papertable").is_ok());
        for bad in [
            "",
            "/",
            "..",
            "a/../b",
            ".obsidian", // 应用元数据目录绝不能当写入根
            ".obsidian/plugins",
            "/Users/qinshu/别处", // 绝对路径
        ] {
            assert!(validate_subtree(bad).is_err(), "应当拒绝：{bad:?}");
        }
    }

    /// 换了子树，容纳断言照样生效——逃逸仍然被拒。
    #[test]
    fn escapes_are_refused_under_a_custom_subtree() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("探索/Papertable")).unwrap();
        assert!(resolve_in(dir.path(), "探索/Papertable", &["笔记.md"]).is_ok());
        assert!(resolve_in(dir.path(), "探索/Papertable", &["..", "逃逸.md"]).is_err());
        assert!(resolve_in(dir.path(), "..", &["逃逸.md"]).is_err());
    }

    /// 容纳规则的自证：写入记账里出现的每一条路径都必须在根之内。
    /// 容纳规则的自证：这次写的两个文件都要出现在记账里，且都在根之内。
    ///
    /// 按**本测试自己的根**过滤，不按下标切片——`WRITE_LOG` 是进程级全局（对单个应用
    /// 进程的审计用途是对的），而测试并行跑在同一进程里，切片会混进别的测试的写入。
    #[test]
    fn every_recorded_write_lands_inside_the_root() {
        let dir = vault();
        write_note_default(dir.path(), &["项目", "甲.md"], "# 甲\n", None).unwrap();
        write_note_default(dir.path(), &["项目", "乙.md"], "# 乙\n", None).unwrap();
        let real_root = root(dir.path()).canonicalize().unwrap();
        let mine: Vec<String> = written_paths()
            .into_iter()
            .filter(|p| Path::new(p).starts_with(&real_root))
            .collect();
        assert_eq!(mine.len(), 2, "每次真实写盘都要记一笔");
        assert!(mine.iter().any(|p| p.ends_with("甲.md")));
        assert!(mine.iter().any(|p| p.ends_with("乙.md")));
    }

    #[test]
    fn renaming_moves_the_file_so_obsidian_can_fix_backlinks() {
        let dir = vault();
        write_note_default(dir.path(), &["项目", "旧标题.md"], "# 旧\n", None).unwrap();
        rename_note(
            dir.path(),
            DEFAULT_SUBTREE,
            &["项目", "旧标题.md"],
            &["项目", "新标题.md"],
        )
        .unwrap();
        assert!(!root(dir.path()).join("项目/旧标题.md").exists());
        assert!(root(dir.path()).join("项目/新标题.md").exists());
    }
}
