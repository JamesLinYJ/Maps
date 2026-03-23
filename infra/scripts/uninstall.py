from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path


def info(message: str) -> None:
    print(f"[INFO] {message}")


def success(message: str) -> None:
    print(f"[OK] {message}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def run(cmd: list[str]) -> None:
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, check=True)


def uninstall(args: argparse.Namespace) -> None:
    service_file = Path("/etc/systemd/system") / f"{args.service_name}.service"
    app_dir = Path(args.app_dir)

    section("卸载参数")
    info(f"服务名: {args.service_name}")
    info(f"部署目录: {app_dir}")

    section("停止并删除 systemd 服务")
    subprocess.run(["systemctl", "disable", "--now", args.service_name], check=False)
    if service_file.exists():
        service_file.unlink()
    run(["systemctl", "daemon-reload"])
    success("systemd 服务已移除")

    section("删除部署目录")
    if app_dir.exists():
        shutil.rmtree(app_dir)
        success("部署目录已删除")
    else:
        info("部署目录不存在，跳过删除")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="卸载 Maps 的 systemd 服务与部署目录。")
    parser.add_argument("--app-dir", default="/opt/maps", help="Installed app directory.")
    parser.add_argument("--service-name", default="maps", help="systemd service name.")
    return parser.parse_args()


if __name__ == "__main__":
    uninstall(parse_args())
