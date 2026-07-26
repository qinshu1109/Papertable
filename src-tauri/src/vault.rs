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

pub const VAULT_SUBTREE: &str = "80_AI暂存/Papertable";

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
pub fn root(vault: &Path) -> PathBuf {
    let mut path = vault.to_path_buf();
    for part in VAULT_SUBTREE.split('/') {
        path.push(part);
    }
    path
}

/// **唯一的写路径解析入口。**
///
/// 拒绝 `..`、绝对路径分量、以及任何 canonicalize 之后落在根之外的目标（符号链接
/// 逃逸就靠这一步）。目标尚不存在时逐级向上找已存在的祖先来 canonicalize，
/// 因为 `canonicalize` 要求路径真实存在。
pub fn resolve(vault: &Path, relative: &[&str]) -> Result<PathBuf> {
    let root = root(vault);
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
            for part in VAULT_SUBTREE.split('/') {
                path.push(part);
            }
            path
        }
    };
    if real_anchor != real_root && !real_anchor.starts_with(&real_root) {
        return Err(format!("拒绝写到容纳目录之外：{}", target.display()).into());
    }
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
    Ok(if suffix.as_os_str().is_empty() {
        real_anchor
    } else {
        real_anchor.join(suffix)
    })
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

/// 按容纳规则写一篇笔记，并在覆盖前检查用户有没有改过它。
///
/// `last_written_hash` 来自 sync_state：`None` 表示我们从没写过这个文件。
pub fn write_note(
    vault: &Path,
    relative: &[&str],
    content: &str,
    last_written_hash: Option<&str>,
) -> Result<WriteReport> {
    let path = resolve(vault, relative)?;
    let display = relative.join("/");
    let next_hash = normalized_hash(content);

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

fn write_atomically(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("papertable-tmp");
    std::fs::write(&temp, content)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

/// 标题变更走 rename 而不是删+建，这样 Obsidian 会自动更新指向它的 `[[双链]]`。
pub fn rename_note(vault: &Path, from: &[&str], to: &[&str]) -> Result<()> {
    let source = resolve(vault, from)?;
    let target = resolve(vault, to)?;
    if !source.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(source, target)?;
    Ok(())
}

pub fn delete_note(vault: &Path, relative: &[&str]) -> Result<()> {
    let path = resolve(vault, relative)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(root(dir.path())).unwrap();
        dir
    }

    #[test]
    fn writes_land_inside_the_owned_subtree() {
        let dir = vault();
        let report = write_note(dir.path(), &["项目", "卡片.md"], "# 内容\n", None).unwrap();
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
        let first = write_note(dir.path(), &path, "---\nk: 1\n---\n\n原始正文。\n", None).unwrap();
        let hash = first.hash.unwrap();

        // 用户在 Obsidian 改了它。
        let file = root(dir.path()).join("项目/卡片.md");
        fs::write(&file, "---\nk: 1\n---\n\n我自己改的正文。\n").unwrap();

        let report = write_note(
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
        let hash = write_note(dir.path(), &path, content, None)
            .unwrap()
            .hash
            .unwrap();

        // Obsidian 保存 → Linter 重排键、加了空行。
        fs::write(
            root(dir.path()).join("项目/卡片.md"),
            "---\na: 1\nb: 2\n---\n\n正文。\n\n\n",
        )
        .unwrap();

        let report = write_note(dir.path(), &path, content, Some(&hash)).unwrap();
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

        let report = write_note(
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

    #[test]
    fn renaming_moves_the_file_so_obsidian_can_fix_backlinks() {
        let dir = vault();
        write_note(dir.path(), &["项目", "旧标题.md"], "# 旧\n", None).unwrap();
        rename_note(dir.path(), &["项目", "旧标题.md"], &["项目", "新标题.md"]).unwrap();
        assert!(!root(dir.path()).join("项目/旧标题.md").exists());
        assert!(root(dir.path()).join("项目/新标题.md").exists());
    }
}
