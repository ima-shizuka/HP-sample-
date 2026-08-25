"""コマンドラインインターフェース。

    python -m kyuyo index   --kintai-dir input/kintai
    python -m kyuyo plan    --shift input/①.xlsx --kintai-dir input/kintai --from-day 24
    python -m kyuyo apply   --shift input/①.xlsx --kintai-dir input/kintai --from-day 24 --yes
    python -m kyuyo summary --kintai-dir input/kintai --summary input/②.xlsm --area 磐田 --write

いずれも既定はドライラン寄り（plan は書き込まない、apply は --yes が必要、
summary は --write が必要）。給与データなので、必ずレポートを目視確認してから反映する。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from zipfile import BadZipFile

from openpyxl.utils.exceptions import InvalidFileException

from . import fixed, report
from .kintai_index import KintaiIndex
from .kintai_write import apply_plans
from .plan import build_plans
from .shift import ShiftBook, merge_entries
from .totals import StaleFormulaCacheError, compute_gakudo_totals, write_to_summary

DEFAULT_OUT = "out"


# ------------------------------------------------------------------ 補助

def load_config(path: str | None) -> dict:
    if not path:
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def require_file(path: str, label: str) -> str:
    """ファイルが無ければ、原因の分かるメッセージで止める。"""
    if os.path.isfile(path):
        return path
    if os.path.isdir(path):
        raise SystemExit(f"{label}にフォルダが指定されています: {path}")
    hint = ""
    parent = os.path.dirname(os.path.abspath(path))
    if os.path.isdir(parent):
        found = sorted(
            f for f in os.listdir(parent)
            if f.lower().endswith((".xlsx", ".xlsm")) and not f.startswith("~$")
        )
        if found:
            hint = "\n  同じフォルダにあるExcel: " + " / ".join(found)
    raise SystemExit(
        f"{label}が見つかりません: {path}\n"
        f"  今いるフォルダ: {os.getcwd()}\n"
        f"  ファイルを置いたか、名前の綴り（拡張子・全角文字）を確認してください。{hint}"
    )


def kintai_paths(directory: str) -> list[str]:
    if not os.path.isdir(directory):
        raise SystemExit(
            f"③のフォルダが見つかりません: {directory}\n"
            f"  今いるフォルダ: {os.getcwd()}\n"
            "  `mkdir input\\kintai` で作り、③のファイルをすべてその中に入れてください。"
        )
    paths = [
        p for p in sorted(glob.glob(os.path.join(directory, "*.xlsx")) +
                          glob.glob(os.path.join(directory, "*.xlsm")))
        if not os.path.basename(p).startswith("~$")
    ]
    if not paths:
        raise SystemExit(
            f"③ファイル(.xlsx/.xlsm)が1つもありません: {directory}\n"
            "  各学童の給与明細シートをこのフォルダに入れてください。"
        )
    return paths


def gakudo_name_from_path(path: str, overrides: dict[str, str] | None = None) -> str:
    """③のファイル名から学童名を取り出す（例: 「__豊岡北小_給与明細シート.xlsx」→「豊岡北小」）。"""
    base = os.path.splitext(os.path.basename(path))[0]
    if overrides and base in overrides:
        return overrides[base]
    name = base.strip("_ ")
    name = re.sub(r"[_\s]*給与明細シート.*$", "", name)
    name = re.sub(r"^\d+[_\-\s]*", "", name)
    return name.strip("_ ") or base


def _echo(text: str) -> None:
    print(text)


# ------------------------------------------------------------------ 各コマンド

def cmd_index(args) -> int:
    index = KintaiIndex.build(kintai_paths(args.kintai_dir))
    text = report.render_index(index)
    _echo(text)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        _echo(f"→ {args.out} に保存しました")
    return 1 if index.duplicates() else 0


def default_fixed_path() -> str | None:
    """fixed_shifts.json を、実行フォルダ → パッケージの親フォルダ の順に探す。"""
    candidates = [
        fixed.DEFAULT_FILENAME,
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     fixed.DEFAULT_FILENAME),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _add_fixed_shifts(args, book, merged) -> None:
    """固定シフト（①に出てこない先生）の勤務を merged に足す。"""
    path = getattr(args, "fixed", None) or default_fixed_path()
    if not path:
        return
    try:
        config = fixed.load_config(path)
    except fixed.FixedShiftConfigError as exc:
        raise SystemExit(f"{os.path.basename(path)} の設定に誤りがあります:\n  {exc}") from exc
    if not config:
        return

    period = (getattr(args, "year", None), getattr(args, "month", None))
    if not all(period):
        period = book.period(args.sheets or None)
    if not period:
        raise SystemExit(
            "固定シフトを展開する年月が分かりません（①のA列に日付が入っていないため）。\n"
            "  --year 2026 --month 8 のように指定してください。"
        )

    year, month = period
    added = fixed.merge_into(merged, fixed.expand(config, year, month))
    names = "、".join(sorted({rule.person for rule in config.rules}))
    _echo(f"固定シフト設定（{os.path.basename(path)}）: {year}年{month}月 / {names} → {added}日分を追加")


def _make_plans(args):
    require_file(args.shift, "①シフト表")
    try:
        book = ShiftBook(args.shift)
    except (BadZipFile, InvalidFileException) as exc:
        raise SystemExit(
            f"①シフト表を開けません: {args.shift}\n"
            f"  {exc}\n"
            "  古い形式(.xls)の場合は、Excelで開いて .xlsx として保存し直してください。"
        ) from exc
    sheets = args.sheets or book.sheet_names
    missing = [s for s in sheets if s not in book.sheet_names]
    if missing:
        raise SystemExit(f"①に無いシート名です: {missing} / 実際: {book.sheet_names}")

    entries = book.parse_all(sheets)
    book.resolve_transfers(entries)
    merged = merge_entries(entries)
    _add_fixed_shifts(args, book, merged)

    index = KintaiIndex.build(kintai_paths(args.kintai_dir))
    plans = build_plans(merged, index, from_day=args.from_day or 1, to_day=args.to_day or 31)
    return plans, index


def cmd_plan(args) -> int:
    plans, _ = _make_plans(args)
    out_dir = args.out_dir or DEFAULT_OUT
    md = report.write_markdown(plans, os.path.join(out_dir, "plan.md"))
    csv_path = report.write_csv(plans, os.path.join(out_dir, "plan.csv"))
    _echo(report.render_markdown(plans))
    _echo(f"\n→ レポート: {md} / {csv_path}")
    if not getattr(args, "no_hint", False):
        _echo("内容を確認したら `apply --yes` で③に書き込みます。")
    return 0


def cmd_apply(args) -> int:
    plans, _ = _make_plans(args)
    out_dir = args.out_dir or DEFAULT_OUT

    if not args.yes:
        report.write_markdown(plans, os.path.join(out_dir, "plan.md"))
        report.write_csv(plans, os.path.join(out_dir, "plan.csv"))
        _echo(report.render_markdown(plans))
        _echo("\n※ --yes が無いので書き込みはしていません（ドライラン）。")
        return 0

    kintai_out = None if args.in_place else os.path.join(out_dir, "kintai")
    result = apply_plans(plans, output_dir=kintai_out, overwrite_filled=args.overwrite_filled)

    # 書き込み後の状態（入力済みでスキップした分を含む）でレポートを出し直す
    report.write_markdown(plans, os.path.join(out_dir, "plan.md"), title="給与予測 転記レポート（書き込み後）")
    report.write_csv(plans, os.path.join(out_dir, "plan.csv"))

    _echo(f"書き込み: {result.written}件 / 入力済みのためスキップ: {result.skipped_existing}件")
    for path in result.files:
        _echo(f"  更新: {path}")
    _echo(f"→ レポート: {os.path.join(out_dir, 'plan.md')}")
    _echo("※ ②へ集計する前に、③をExcelで開いて保存し直してください（数式の再計算のため）。")
    return 0


def cmd_summary(args) -> int:
    paths = kintai_paths(args.kintai_dir)
    overrides = load_config(args.config).get("gakudo_names") if args.config else None

    totals = {}
    for path in paths:
        try:
            totals[gakudo_name_from_path(path, overrides)] = compute_gakudo_totals(path)
        except (KeyError, StaleFormulaCacheError) as exc:
            _echo(f"⚠ {os.path.basename(path)}: {exc}")

    _echo("=== ③ 事業所合計 ===")
    for name, t in sorted(totals.items()):
        _echo(f"  {name}: 給与={t.aa_salary:,.0f} 処遇改善={t.bb_kaizen:,.0f} 交通費={t.cc_transit:,.0f}")
    _echo(f"  合計: 給与={sum(t.aa_salary for t in totals.values()):,.0f} "
          f"処遇改善={sum(t.bb_kaizen for t in totals.values()):,.0f} "
          f"交通費={sum(t.cc_transit for t in totals.values()):,.0f}")

    if not args.summary:
        _echo("\n※ --summary で②のファイルを指定すると転記できます。")
        return 0

    require_file(args.summary, "②全社集計")
    # --in-place なら元ファイルに直接書き込む。そうでなければ out フォルダにコピー
    if args.in_place:
        out_path = args.summary
    else:
        out_path = args.out or os.path.join(args.out_dir or DEFAULT_OUT, os.path.basename(args.summary))
    results = write_to_summary(
        args.summary, args.area, totals,
        start_row=args.start_row, output_path=out_path, dry_run=not args.write,
    )
    _echo(f"\n=== ②「{args.area}」シートへの転記{'' if args.write else '（ドライラン）'} ===")
    for name, message in sorted(results.items()):
        _echo(f"  {name}: {message}")
    if args.write:
        _echo(f"→ {out_path} に保存しました")
    else:
        _echo("※ 実際に書き込むには --write を付けてください。")
    return 0


def cmd_wizard(args) -> int:
    from .wizard import run  # 循環importを避けるためここで読み込む

    return run(args.input_dir or "input", args.out_dir or DEFAULT_OUT)


# ------------------------------------------------------------------ パーサ

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kyuyo", description="学童 給与予測 自動転記")
    parser.add_argument("--config", help="既定値を書いた JSON（config.example.json 参照）")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_kintai(p):
        p.add_argument("--kintai-dir", help="③（給与明細シート）を置いたフォルダ")

    p_index = sub.add_parser("index", help="③の氏名インデックスを点検する")
    add_kintai(p_index)
    p_index.add_argument("--out", help="レポートの保存先(.md)")
    p_index.set_defaults(func=cmd_index)

    def add_plan_args(p):
        p.add_argument("--shift", help="①シフト表(.xlsx)")
        add_kintai(p)
        p.add_argument("--sheets", nargs="*", help="対象の学童シート名（既定: 全シート）")
        p.add_argument("--from-day", type=int, help="この日から埋める（中締めの翌日、既定1日）")
        p.add_argument("--to-day", type=int, help="この日まで埋める（既定31日）")
        p.add_argument("--out-dir", help=f"出力先フォルダ（既定: {DEFAULT_OUT}）")
        p.add_argument("--fixed", help=f"固定シフト設定（既定: {fixed.DEFAULT_FILENAME} があれば自動で使う）")
        p.add_argument("--year", type=int, help="対象年（①に日付が無いときのみ必要）")
        p.add_argument("--month", type=int, help="対象月（①に日付が無いときのみ必要）")

    p_plan = sub.add_parser("plan", help="①を読み、③への書き込み計画をレポート出力する（書き込まない）")
    add_plan_args(p_plan)
    p_plan.add_argument("--no-hint", action="store_true", help=argparse.SUPPRESS)
    p_plan.set_defaults(func=cmd_plan)

    p_apply = sub.add_parser("apply", help="計画どおり③に書き込む（--yes が必要）")
    add_plan_args(p_apply)
    p_apply.add_argument("--yes", action="store_true", help="実際に書き込む")
    p_apply.add_argument("--in-place", action="store_true", help="③の原本を直接書き換える（既定はコピーに書く）")
    p_apply.add_argument("--overwrite-filled", action="store_true", help="入力済みのセルも上書きする")
    p_apply.set_defaults(func=cmd_apply)

    p_sum = sub.add_parser("summary", help="③の合計を計算し、②に転記する")
    add_kintai(p_sum)
    p_sum.add_argument("--summary", help="②全社集計(.xlsm)")
    p_sum.add_argument("--area", default="磐田", help="②のシート名（磐田 / 浜松）")
    p_sum.add_argument("--start-row", type=int, help="②の走査開始行（磐田=73）")
    p_sum.add_argument("--out", help="②の出力先ファイル")
    p_sum.add_argument("--out-dir", help=f"出力先フォルダ（既定: {DEFAULT_OUT}）")
    p_sum.add_argument("--in-place", action="store_true", help="②の原本を直接書き換える（既定はコピーに書く）")
    p_sum.add_argument("--write", action="store_true", help="実際に②へ書き込む")
    p_sum.set_defaults(func=cmd_summary)

    p_wiz = sub.add_parser("wizard", help="対話モード（「開始」から呼ばれる。input フォルダを自動で読む）")
    p_wiz.add_argument("--input-dir", help="①②③を置いたフォルダ（既定: input）")
    p_wiz.add_argument("--out-dir", help=f"出力先フォルダ（既定: {DEFAULT_OUT}）")
    p_wiz.set_defaults(func=cmd_wizard)
    return parser


def apply_config_defaults(args, config: dict) -> None:
    """CLIで未指定（None または空リスト）の項目だけ config の値で埋める。"""
    for key, value in config.items():
        attr = key.replace("-", "_")
        if not hasattr(args, attr):
            continue
        current = getattr(args, attr)
        if current is None or current == []:
            setattr(args, attr, value)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    apply_config_defaults(args, load_config(args.config))

    required = {"index": ["kintai_dir"], "plan": ["shift", "kintai_dir"],
                "apply": ["shift", "kintai_dir"], "summary": ["kintai_dir"]}
    for name in required.get(args.command, []):
        if not getattr(args, name, None):
            parser.error(f"--{name.replace('_', '-')} を指定してください（または --config で）")

    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
