"""「開始」をダブルクリックするだけで一連の作業を進める対話モード。

`開始.bat` から `python -m kyuyo wizard` として呼ばれる。
input フォルダに置かれたファイルを自動で見つけ、
    ① レポート作成（書き込みなし） → 目視確認
    ② ③への書き込み               → Excelで開いて保存
    ③ ②への集計転記
を、都度「はい/いいえ」で確認しながら進める。
"""

from __future__ import annotations

import glob
import os

DEFAULT_INPUT = "input"
DEFAULT_OUT = "out"
KINTAI_SUBDIR = "kintai"

LINE = "─" * 60


# ------------------------------------------------------------------ 入出力の補助

def _echo(text: str = "") -> None:
    print(text)


def ask(prompt: str, default: str = "") -> str:
    suffix = f"（未入力なら {default}）" if default else ""
    try:
        answer = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        return default
    return answer or default


def ask_yes(prompt: str, default: bool = True) -> bool:
    choice = "[Y/n]" if default else "[y/N]"
    answer = ask(f"{prompt} {choice}").lower()
    if not answer:
        return default
    return answer.startswith("y")


def open_in_explorer(path: str) -> None:
    """Windowsならエクスプローラー/Excelで開く（他OSでは何もしない）。"""
    try:
        os.startfile(os.path.abspath(path))  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        pass


# ------------------------------------------------------------------ 入力ファイルの発見

def _excels(directory: str, ext: str) -> list[str]:
    return sorted(
        p for p in glob.glob(os.path.join(directory, f"*{ext}"))
        if not os.path.basename(p).startswith("~$")
    )


def find_inputs(base_dir: str = DEFAULT_INPUT) -> dict:
    """input フォルダの中身を調べ、①②③のパスと不足の案内を返す。

    ①は shift.xlsx、②は summary.xlsm を優先し、無ければフォルダ内で
    一意に決まる場合のみ自動採用する（複数あって決められない場合は None）。
    """
    kintai_dir = os.path.join(base_dir, KINTAI_SUBDIR)
    result = {"base": base_dir, "shift": None, "summary": None,
              "kintai_dir": kintai_dir, "kintai_files": [], "problems": []}

    if not os.path.isdir(base_dir):
        result["problems"].append(f"{base_dir} フォルダがありません")
        return result

    # ① シフト表（kintai フォルダの中は見ない）
    xlsx = [p for p in _excels(base_dir, ".xlsx")]
    named = os.path.join(base_dir, "shift.xlsx")
    if os.path.isfile(named):
        result["shift"] = named
    elif len(xlsx) == 1:
        result["shift"] = xlsx[0]
    elif not xlsx:
        result["problems"].append(f"①シフト表がありません（{base_dir}\\shift.xlsx として置いてください）")
    else:
        result["problems"].append(
            f"①シフト表を特定できません。{base_dir} の直下に .xlsx が複数あります: "
            + " / ".join(os.path.basename(p) for p in xlsx)
            + "。使うものを shift.xlsx にリネームしてください"
        )

    # ② 全社集計（無くても①→③だけは進められる）
    xlsm = _excels(base_dir, ".xlsm")
    named = os.path.join(base_dir, "summary.xlsm")
    if os.path.isfile(named):
        result["summary"] = named
    elif len(xlsm) == 1:
        result["summary"] = xlsm[0]

    # ③ 各学童の給与明細シート
    if os.path.isdir(kintai_dir):
        result["kintai_files"] = _excels(kintai_dir, ".xlsx") + _excels(kintai_dir, ".xlsm")
    if not result["kintai_files"]:
        result["problems"].append(f"③がありません（{kintai_dir} にすべて入れてください）")

    return result


def ensure_folders(base_dir: str = DEFAULT_INPUT) -> None:
    os.makedirs(os.path.join(base_dir, KINTAI_SUBDIR), exist_ok=True)


# ------------------------------------------------------------------ 本体

def run(base_dir: str = DEFAULT_INPUT, out_dir: str = DEFAULT_OUT) -> int:
    from . import cli  # 循環importを避けるためここで読み込む

    _echo(LINE)
    _echo("  学童 給与予測 自動転記")
    _echo(LINE)
    _echo("この画面の指示どおりに Enter を押していけば終わります。")
    _echo("途中でやめたいときは、そのまま画面を閉じてください（③②は書き換わりません）。")
    _echo()

    ensure_folders(base_dir)
    found = find_inputs(base_dir)

    if found["problems"]:
        _echo("■ 今月のファイルが足りません")
        for problem in found["problems"]:
            _echo(f"  ・{problem}")
        _echo()
        _echo(f"  {os.path.abspath(base_dir)} を開きます。以下のように置いてから、もう一度「開始」してください。")
        _echo("    ① シフト表          → input\\shift.xlsx")
        _echo("    ② 全社集計          → input\\summary.xlsm")
        _echo("    ③ 各学童の給与明細  → input\\kintai\\ の中に全部（名前はそのまま）")
        open_in_explorer(base_dir)
        return 1

    _echo("■ 今月のファイル")
    _echo(f"  ① シフト表 : {os.path.basename(found['shift'])}")
    _echo(f"  ③ 給与明細 : {len(found['kintai_files'])}ファイル")
    _echo(f"  ② 全社集計 : {os.path.basename(found['summary']) if found['summary'] else '（未配置。③までで止まります）'}")
    _echo()

    from_day = ask("中締めの翌日（この日から埋めます）", "1")
    if not from_day.isdigit() or not (1 <= int(from_day) <= 31):
        _echo("→ 1〜31 の数字で入れてください。1日から埋める設定にします。")
        from_day = "1"
    _echo()

    # ---------------------------------------------------------- 1. レポート
    _echo(LINE)
    _echo("【1/3】①を読んで、書き込み内容の一覧を作ります（まだ何も書き換えません）")
    _echo(LINE)
    common = ["--shift", found["shift"], "--kintai-dir", found["kintai_dir"],
              "--from-day", from_day, "--out-dir", out_dir]
    try:
        cli.main(["plan", *common, "--no-hint"])
    except SystemExit as exc:
        if exc.code:
            _echo(f"\n{exc}")
            return 1

    csv_path = os.path.join(out_dir, "plan.csv")
    _echo()
    _echo(f"→ 一覧を開きます: {os.path.abspath(csv_path)}")
    _echo("  「要確認」の行は自動では書き込みません。内容を確認してください。")
    open_in_explorer(csv_path)
    _echo()

    if not ask_yes("この内容で③（給与明細シート）に書き込みますか？", default=False):
        _echo("→ 書き込まずに終了します。①や③を直して、もう一度「開始」してください。")
        return 0

    # ---------------------------------------------------------- 2. ③へ書き込み
    _echo()
    _echo(LINE)
    _echo("【2/3】③に書き込みます（原本は変更せず、out\\kintai にコピーを作ります）")
    _echo(LINE)
    try:
        cli.main(["apply", *common, "--yes"])
    except SystemExit as exc:
        if exc.code:
            _echo(f"\n{exc}")
            return 1

    kintai_out = os.path.join(out_dir, KINTAI_SUBDIR)
    _echo()
    _echo(f"→ 書き込んだファイル: {os.path.abspath(kintai_out)}")
    open_in_explorer(kintai_out)

    if not found["summary"]:
        _echo("\n② 全社集計のファイルが input に無いので、ここまでで終了します。")
        return 0

    _echo()
    _echo("■ 次の②への集計の前に、ひと手間だけお願いします")
    _echo("  上のフォルダの③を Excel で開いて、そのまま上書き保存してください（全ファイル）。")
    _echo("  Excelが計算し直した金額を読み取るために必要です。")
    _echo()

    if not ask_yes("③をExcelで開いて保存しましたか？ ②への集計に進みます", default=False):
        _echo("→ ここで終了します。保存が終わったら、もう一度「開始」して【3/3】だけ実行できます。")
        return 0

    # ---------------------------------------------------------- 3. ②へ集計
    _echo()
    _echo(LINE)
    _echo("【3/3】③の合計を②に転記します")
    _echo(LINE)
    area = ask("②のシート名", "磐田")
    try:
        cli.main(["summary", "--kintai-dir", kintai_out, "--summary", found["summary"],
                  "--area", area, "--out-dir", out_dir, "--write"])
    except SystemExit as exc:
        if exc.code:
            _echo(f"\n{exc}")
            return 1

    _echo()
    _echo(f"→ 完成したファイルは {os.path.abspath(out_dir)} にあります。")
    _echo("  金額を目視確認してから、正式な給与計算に使ってください。")
    open_in_explorer(out_dir)
    return 0
