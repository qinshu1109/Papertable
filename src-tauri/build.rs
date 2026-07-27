use std::process::Command;

fn main() {
    // 把构建标识编进二进制，让每一份产物都能自我说明。
    //
    // 三份 bundle 共用 bundle id、共用 v0.1.0、共用同一个数据库，界面上却无从分辨
    // 打开的是哪一份——「改了没生效」就是这么来的，而且没有任何症状。
    let sha = Command::new("git")
        .args(["rev-parse", "--short=9", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .map(|out| !out.stdout.is_empty())
        .unwrap_or(false);
    println!(
        "cargo:rustc-env=PAPERTABLE_COMMIT={}{}",
        sha,
        if dirty { "+改动未提交" } else { "" }
    );
    // 构建时间戳。用 date 而不是 chrono，免得为一行信息多一个依赖。
    let built = Command::new("date")
        .args(["+%Y-%m-%d %H:%M"])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=PAPERTABLE_BUILT_AT={built}");
    // 源码变了就要重新取一次 git 信息。
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../src");

    tauri_build::build()
}
