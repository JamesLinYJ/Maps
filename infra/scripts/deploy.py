from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def info(message: str) -> None:
    print(f"[INFO] {message}")


def success(message: str) -> None:
    print(f"[OK] {message}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print(f"+ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, check=True)


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def ensure_python_version() -> None:
    if sys.version_info < (3, 12):
        raise RuntimeError("deploy.py requires Python 3.12+")


def build_systemd_service(app_dir: Path, port: int, service_name: str) -> str:
    return f"""[Unit]
Description=Maps voice map presenter
After=network.target

[Service]
Type=simple
WorkingDirectory={app_dir}
Environment=PYTHONPATH={app_dir}
EnvironmentFile=-{app_dir}/.env
ExecStart={app_dir}/.venv/bin/python -m uvicorn apps.backend.app.main:app --host 0.0.0.0 --port {port}
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
"""


def copy_repo(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(
        src,
        dst,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns(
            "node_modules",
            "dist",
            ".git",
            ".pytest_cache",
            "__pycache__",
            "*.pyc",
            ".backend.log",
            ".backend.err.log",
            ".web.log",
            ".web.err.log",
        ),
    )


def ensure_env_file(app_dir: Path) -> None:
    env_file = app_dir / ".env"
    if env_file.exists():
        return
    example_file = app_dir / ".env.example"
    if example_file.exists():
        shutil.copyfile(example_file, env_file)


def deploy(args: argparse.Namespace) -> None:
    ensure_python_version()
    repo_root = Path(args.repo_root).resolve()
    app_dir = Path(args.app_dir).resolve()
    service_file = Path("/etc/systemd/system") / f"{args.service_name}.service"

    section("部署参数")
    info(f"源代码目录: {repo_root}")
    info(f"部署目录: {app_dir}")
    info(f"systemd 服务名: {args.service_name}")
    info(f"监听端口: {args.port}")

    section("复制代码")
    copy_repo(repo_root, app_dir)
    ensure_env_file(app_dir)
    success("代码已复制到部署目录")

    section("创建 Python 运行环境")
    run([sys.executable, "-m", "venv", str(app_dir / ".venv")])
    venv_python = app_dir / ".venv" / "bin" / "python"
    venv_pip = [str(venv_python), "-m", "pip"]
    run(venv_pip + ["install", "--upgrade", "pip", "setuptools", "wheel"])
    run(venv_pip + ["install", "-e", "."], cwd=app_dir)
    success("Python 依赖安装完成")

    section("安装前端依赖并构建")
    run(["npm", "ci"], cwd=app_dir)
    run(["npm", "run", "build:web"], cwd=app_dir)
    success("前端构建完成")

    section("写入并启用 systemd 服务")
    service_content = build_systemd_service(app_dir, args.port, args.service_name)
    write_text(service_file, service_content)

    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", args.service_name])
    run(["systemctl", "restart", args.service_name])
    run(["systemctl", "status", args.service_name, "--no-pager"])
    success("systemd 服务已启动")

    section("部署完成")
    success(f"服务访问地址: http://<服务器IP>:{args.port}")
    info(f"健康检查地址: http://<服务器IP>:{args.port}/health")
    info(f"如需修改模型密钥，请编辑: {app_dir / '.env'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="以 systemd 方式部署 Maps，并在单端口下同时提供网页和 API。"
    )
    parser.add_argument("--repo-root", default=".", help="Local repo root to package for deployment.")
    parser.add_argument("--app-dir", default="/opt/maps", help="Target install directory.")
    parser.add_argument("--port", type=int, default=5010, help="Server port for uvicorn.")
    parser.add_argument("--service-name", default="maps", help="systemd service name.")
    return parser.parse_args()


if __name__ == "__main__":
    deploy(parse_args())
