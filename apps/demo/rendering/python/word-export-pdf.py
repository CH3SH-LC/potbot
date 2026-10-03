#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""**真实排版引擎**适配器：用本机 Microsoft Word（COM）把 DOCX 导出为 PDF。

对应 design-05 **WF-089**（PDF 导出）。这是**唯一的真实排版引擎路线**——本机
（2026-10-02 WCF-D06 实测）**没有 LibreOffice、没有 WPS**，只有
`C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE`（16.0.20430，**未经授权但 COM 可用**）。

用法：

    python word-export-pdf.py <in.docx> <out.pdf> [--report <report.json>] [--engine-timeout <sec>]

**纪律（改本文件前先读）**：

* **不许伪造**：产物必须是 Word 的 `ExportAsFixedFormat` 输出的真 PDF；**绝不**靠改扩展名。
* **失败必须结构化**：`failure.kind` 取封闭枚举之一（见下），**不得**把"没导出"报成成功。
  - `source_missing`      —— 源 DOCX 不存在
  - `engine_unavailable`  —— pywin32 缺失 / Word ProgID 未注册 / DispatchEx 失败
  - `engine_unlicensed`   —— 引擎因授权问题拒绝工作（注册表只读到的"未授权"是**提示**，不是失败）
  - `target_not_writable` —— 目标目录不存在或不可写（**在起 Word 之前**判定）
  - `engine_error`        —— 其它引擎错误（含 Word 拒开 24601 一类）
* **不留孤儿进程**：报告文件**分阶段增量写**，`word_pid` 一旦拿到就落盘，
  好让调用方在超时后能 `taskkill /F /PID` **只杀我们起的这一个** Word 实例。
* **超时不在这里**：COM 调用是阻塞的，真正的超时由调用方（TS 端口 / 脚本）控制；
  本脚本的 `--engine-timeout` 只做阶段之间的兜底自检。
* 退出码：**0 = 导出成功且产物非空**；**1 = 失败（见 `failure.kind`）**；**2 = 用法错误**。

**未验证边界（诚实声明）**：本路线是 **Windows 桌面专属**；目标平台 Android 上用不了。
手机端 PDF 导出与打印**未在本脚本、也未在任何真机上验证**。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import traceback

WD_EXPORT_FORMAT_PDF = 17
WD_EXPORT_ALL_DOCUMENT = 0
WD_EXPORT_OPTIMIZE_FOR_PRINT = 0
WD_DO_NOT_SAVE_CHANGES = 0

FAILURE_KINDS = (
    "source_missing",
    "engine_unavailable",
    "engine_unlicensed",
    "target_not_writable",
    "engine_error",
)

# 命中这些词就认为**引擎自己**因授权拒绝（注册表读到的"未授权"不作为失败，只作提示）。
LICENSE_HINTS = ("license", "licence", "activation", "activate", "product key", "not licensed",
                 "未经授权", "未授权", "激活", "授权")


def digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def classify(exc: BaseException) -> str:
    """把异常映射成封闭枚举里的一个 kind；**不猜**，命中不了就归 `engine_error`。"""
    text = ("%s %s" % (type(exc).__name__, exc)).lower()
    if any(hint in text for hint in LICENSE_HINTS):
        return "engine_unlicensed"
    return "engine_error"


def read_license_advisory() -> dict:
    """**只读**注册表，记下 Word 自报的授权状态。这是**提示**，不是判据。

    WCF-D06 实测：Word 自报「未经授权产品」，但 COM 域刷新与 PDF 导出**完全可用**。
    所以本函数只描述现状，**不改变**导出是否继续。
    """
    advisory = {"state": "unknown", "evidence": "", "unlicensed_but_usable_observed": False}
    try:
        import winreg  # noqa: PLC0415

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"SOFTWARE\Microsoft\Office\16.0\Word") as key:
                name, _ = winreg.QueryValueEx(key, "WordName")
                advisory["evidence"] = "HKCU\\...\\Office\\16.0\\Word\\WordName=%r" % (name,)
                # 注意「未经授权」≠「未授权」：本机实测到的原文是「Word (未经授权产品)」，
                # 只匹配「未授权」会**漏判**并谎报 licensed —— 这属于编造，必须两个都匹配。
                lowered = str(name).lower()
                marked = any(marker in str(name) for marker in ("未经授权", "未授权")) \
                    or ("unlicensed" in lowered) or ("not licensed" in lowered)
                advisory["state"] = "unlicensed" if marked else "licensed"
                advisory["unlicensed_but_usable_observed"] = bool(marked)
        except OSError as exc:
            advisory["evidence"] = "读 WordName 失败：%s" % exc
    except Exception as exc:  # pragma: no cover - winreg 在 Windows 上总在
        advisory["evidence"] = "winreg 不可用：%s" % exc
    return advisory


def probe_target_dir(target_pdf: str) -> tuple[bool, str]:
    """**在起 Word 之前**判定目标目录可写——省得白起一个 355 MB 的进程。"""
    directory = os.path.dirname(os.path.abspath(target_pdf)) or os.getcwd()
    if not os.path.isdir(directory):
        return False, "目标目录不存在：%s" % directory
    probe = os.path.join(directory, ".potbot-write-probe-%d.tmp" % os.getpid())
    try:
        with open(probe, "wb") as handle:
            handle.write(b"probe")
        os.remove(probe)
        return True, directory
    except OSError as exc:
        return False, "目标目录不可写（%s）：%s" % (directory, exc)


def list_word_pids() -> set:
    """当前 WINWORD.EXE 的 PID 集合（`tasklist` CSV）。

    **不要**用 `app.Hwnd` + `GetWindowThreadProcessId`：晚绑定下 `Word.Application.Hwnd`
    根本不存在（实测报 `AttributeError: Word.Application.Hwnd`），
    于是 `word_pid` 一直是 None、清理被跳过、**留下 355 MB 的孤儿 Word**——这个坑踩过。
    """
    try:
        import subprocess  # noqa: PLC0415

        done = subprocess.run(["tasklist", "/FI", "IMAGENAME eq WINWORD.EXE", "/FO", "CSV", "/NH"],
                              capture_output=True, text=True, timeout=20)
        pids = set()
        for line in (done.stdout or "").splitlines():
            line = line.strip()
            if not line.startswith('"'):
                continue  # 无匹配时 tasklist 打的是「信息: ...」，不是 CSV
            parts = [piece.strip('"') for piece in line.split('","')]
            if len(parts) >= 2 and parts[1].isdigit():
                pids.add(int(parts[1]))
        return pids
    except Exception:
        return set()


def discover_word_pid(before: set, attempts: int = 20, delay: float = 0.25):
    """`DispatchEx` 之后新出现的 WINWORD.EXE 就是我们起的那个（差集，最多等 ~5 s）。"""
    for _ in range(attempts):
        new = list_word_pids() - before
        if new:
            return sorted(new)[0], sorted(new)
        time.sleep(delay)
    return None, []


def kill_word(pid) -> str:
    """**只杀我们起的那个** Word（按 PID，不用 `IM WINWORD.EXE`——那会连用户自己开的文档一起杀）。

    `app.Quit()` 实测不可靠（WCF-D06：三次里两次 `WINWORD.EXE` 仍在），所以留这个兜底。
    返回一行可粘贴的证据文本。
    """
    if not pid:
        return "skip: 没有 word_pid"
    try:
        import subprocess  # noqa: PLC0415

        done = subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                              capture_output=True, text=True, timeout=20)
        text = (done.stdout or done.stderr or "").strip().replace("\n", " ")
        return "taskkill /F /PID %s -> rc=%s %s" % (pid, done.returncode, text)
    except Exception as exc:  # pragma: no cover
        return "taskkill 失败：%s" % exc


def probe(report_path: str) -> int:
    """探测引擎是否可用。**不打开任何文档**；起的 Word 用完按 PID 清掉。"""
    report = {"ok": False, "mode": "probe", "python_pid": os.getpid(), "word_pid": None,
              "engine": None, "license": read_license_advisory(), "failure": None,
              "cleanup": None}
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
    try:
        import win32com.client as wc  # noqa: PLC0415
    except Exception as exc:
        report["failure"] = {"kind": "engine_unavailable", "message": "pywin32 不可用：%s" % exc}
        return _emit(report, report_path, 1)

    app = None
    try:
        before = list_word_pids()
        app = wc.DispatchEx("Word.Application")
        app.Visible = False
        app.DisplayAlerts = 0
        report["word_pid"], report["word_pids_new"] = discover_word_pid(before)
        if report["word_pid"] is None:
            report["word_pid_error"] = "DispatchEx 后未在 tasklist 里看到新的 WINWORD.EXE"
        report["engine"] = {
            "name": str(app.Name), "version": str(app.Version), "build": str(app.Build),
            "route": "microsoft-word-com/ExportAsFixedFormat", "platform": "windows-desktop",
        }
        report["ok"] = True
    except Exception as exc:
        report["failure"] = {"kind": classify(exc), "message": "%s: %s" % (type(exc).__name__, exc)}
    finally:
        if app is not None:
            try:
                app.Quit(0)
            except Exception:
                pass
            if report.get("word_pid") is None:
                # 起的时候没认出来？收尾再认一次——**不许**把 355 MB 的孤儿留在用户机器上。
                report["word_pid"], _ = discover_word_pid(before, attempts=8, delay=0.25)
            report["cleanup"] = kill_word(report.get("word_pid"))
    return _emit(report, report_path, 0 if report["ok"] else 1)


def _emit(report: dict, report_path: str, code: int) -> int:
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return code


def export(source: str, target: str, report_path: str, engine_timeout: float) -> int:
    started = time.time()
    report = {
        "ok": False,
        "stage": "start",
        "python_pid": os.getpid(),
        "word_pid": None,
        "source": os.path.abspath(source),
        "target": os.path.abspath(target),
        "engine": None,
        "license": None,
        "failure": None,
        "traceback": None,
        "timing": {},
        "output": None,
    }

    def flush(stage: str) -> None:
        report["stage"] = stage
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)

    flush("start")

    if not os.path.isfile(source):
        report["failure"] = {"kind": "source_missing", "message": "源 DOCX 不存在：%s" % source}
        flush("done")
        return 1

    writable, detail = probe_target_dir(target)
    if not writable:
        report["failure"] = {"kind": "target_not_writable", "message": detail}
        flush("done")
        return 1

    report["license"] = read_license_advisory()

    try:
        import win32com.client as wc  # noqa: PLC0415
    except Exception as exc:
        report["failure"] = {"kind": "engine_unavailable",
                             "message": "pywin32 不可用：%s" % exc}
        flush("done")
        return 1

    app = None
    doc = None
    try:
        before = list_word_pids()
        dispatch_start = time.time()
        app = wc.DispatchEx("Word.Application")
        report["timing"]["dispatch_s"] = round(time.time() - dispatch_start, 3)

        app.Visible = False
        app.DisplayAlerts = 0
        report["word_pid"], report["word_pids_new"] = discover_word_pid(before)
        if report["word_pid"] is None:
            report["word_pid_error"] = "DispatchEx 后未在 tasklist 里看到新的 WINWORD.EXE"
        report["engine"] = {
            "name": str(app.Name),
            "version": str(app.Version),
            "build": str(app.Build),
            "route": "microsoft-word-com/ExportAsFixedFormat",
            "platform": "windows-desktop",
        }
        flush("dispatched")

        open_start = time.time()
        doc = app.Documents.Open(os.path.abspath(source), ReadOnly=True,
                                 AddToRecentFiles=False, ConfirmConversions=False)
        report["timing"]["open_s"] = round(time.time() - open_start, 3)
        report["timing"]["pages"] = int(doc.ComputeStatistics(2))  # wdStatisticPages
        flush("opened")

        if engine_timeout > 0 and (time.time() - started) > engine_timeout:
            raise TimeoutError("引擎阶段耗时超过 %ss（自检）" % engine_timeout)

        export_start = time.time()
        doc.ExportAsFixedFormat(os.path.abspath(target), WD_EXPORT_FORMAT_PDF, False,
                                WD_EXPORT_OPTIMIZE_FOR_PRINT, WD_EXPORT_ALL_DOCUMENT)
        report["timing"]["export_s"] = round(time.time() - export_start, 3)
        flush("exported")

        if not os.path.isfile(target) or os.path.getsize(target) == 0:
            report["failure"] = {"kind": "engine_error",
                                 "message": "引擎报成功但产物不存在或为空：%s" % target}
            flush("done")
            return 1

        with open(target, "rb") as handle:
            head = handle.read(5)
        report["output"] = {
            "path": os.path.abspath(target),
            "bytes": os.path.getsize(target),
            "sha256": digest(target),
            "magic": head.decode("latin-1"),
            "magic_ok": head == b"%PDF-",
        }
        report["ok"] = True
    except Exception as exc:
        report["failure"] = {
            "kind": classify(exc),
            "message": "%s: %s" % (type(exc).__name__, exc),
            "traceback": traceback.format_exc(),
        }
    finally:
        if doc is not None:
            try:
                doc.Close(WD_DO_NOT_SAVE_CHANGES)
            except Exception:
                pass
        if app is not None:
            try:
                app.Quit(0)
            except Exception:
                pass
            if report.get("word_pid") is None:
                # 起的时候没认出来？收尾再认一次——**不许**把 355 MB 的孤儿留在用户机器上。
                report["word_pid"], _ = discover_word_pid(before, attempts=8, delay=0.25)
            report["cleanup"] = kill_word(report.get("word_pid"))

    report["timing"]["total_s"] = round(time.time() - started, 3)
    flush("done")
    return 0 if report["ok"] else 1


def main(argv) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("source", nargs="?")
    parser.add_argument("target", nargs="?")
    parser.add_argument("--probe", action="store_true",
                        help="只探测引擎是否可用，不导出")
    parser.add_argument("--report", default=None)
    parser.add_argument("--engine-timeout", type=float, default=0.0)
    args = parser.parse_args(argv[1:])

    if args.probe:
        return probe(args.report)

    if not args.source or not args.target:
        sys.stderr.write("用法：word-export-pdf.py <in.docx> <out.pdf> [--report r.json] "
                         "| word-export-pdf.py --probe [--report r.json]\n")
        return 2

    report_path = args.report or (os.path.abspath(args.target) + ".report.json")
    code = export(args.source, args.target, report_path, args.engine_timeout)

    summary = {"ok": None, "stage": None, "engine": None, "license": None,
               "failure": None, "output": None, "report": os.path.abspath(report_path)}
    try:
        with open(report_path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        for key in summary:
            if key in loaded:
                summary[key] = loaded[key]
    except Exception as exc:
        summary["report_read_error"] = str(exc)
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
