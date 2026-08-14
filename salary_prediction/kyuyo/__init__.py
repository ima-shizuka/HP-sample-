"""学童 給与予測 自動転記パッケージ。

①シフト表 → ③各学童の給与明細シート → ②全社集計、の3段階を自動化する。
仕様は SPEC.md（業務ルールの唯一の情報源）を参照。
"""

from .kintai_index import KintaiIndex, SheetRef
from .kintai_write import apply_plans
from .plan import WritePlan, build_plans, compute_break_minutes
from .shift import DayEntry, ShiftBook, merge_entries
from .totals import GakudoTotals, compute_gakudo_totals, write_to_summary

__all__ = [
    "KintaiIndex",
    "SheetRef",
    "ShiftBook",
    "DayEntry",
    "merge_entries",
    "WritePlan",
    "build_plans",
    "compute_break_minutes",
    "apply_plans",
    "GakudoTotals",
    "compute_gakudo_totals",
    "write_to_summary",
]

__version__ = "0.1.0"
