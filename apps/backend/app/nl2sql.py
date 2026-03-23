from __future__ import annotations

from dataclasses import dataclass

from .schemas import IntentClassification


@dataclass
class Nl2SqlPlan:
    mode: str
    target: str
    sql_preview: str


class Nl2SqlPlanner:
    """
    Keep NL2SQL explicit in the architecture while the backend moves toward
    structured query execution over the active feature set.
    """

    def maybe_plan(
        self,
        transcript_text: str,
        classification: IntentClassification,
    ) -> Nl2SqlPlan | None:
        # 只在用户明显在问“统计/列表/分布”这类结构化问题时，才生成 NL2SQL 计划。
        keywords = ("统计", "数量", "多少", "占比", "分布", "哪些", "列表")
        if not any(keyword in transcript_text for keyword in keywords):
            return None

        target = classification.focus_query or classification.intent
        # SQL 预览只做说明性输出，真正执行时仍应走受控查询层和参数化策略。
        safe_target = target.replace("'", " ").strip() or "map_presentation_features"
        return Nl2SqlPlan(
            mode="structured_lookup",
            target=target,
            sql_preview=(
                "SELECT id, name, kind FROM features "
                f"WHERE name LIKE '%{safe_target}%' ORDER BY name LIMIT 10;"
            ),
        )
