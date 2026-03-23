import type { ReactNode } from "react";

import type { MapPolicy, SourceCard } from "@maps/schemas";
import type { VoiceStatus } from "@maps/voice-core";

export function StatusBadge({ status }: { status: VoiceStatus }) {
  const label: Record<VoiceStatus, string> = {
    idle: "待命",
    listening: "收音中",
    thinking: "处理中",
    speaking: "讲解中",
    error: "异常"
  };

  return <span className={`status-badge status-${status}`}>{label[status]}</span>;
}

export function SectionCard(props: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel-card">
      <div className="panel-heading">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
      </div>
      {props.children}
    </section>
  );
}

export function SourceCardList({ cards }: { cards: SourceCard[] }) {
  return (
    <div className="source-grid">
      {cards.map((card) => (
        <article className="source-card" key={card.id}>
          <p className="source-provider">{card.provider}</p>
          <h3>{card.title}</h3>
          <p>{card.note}</p>
        </article>
      ))}
    </div>
  );
}

export function CompliancePanel({ policy }: { policy: MapPolicy }) {
  return (
    <div className="compliance-stack">
      {/* 合规信息必须始终可见，不能因为版式优化而被折叠到二级区域。 */}
      <p>
        <strong>{policy.providerDisplayName}</strong>
      </p>
      <p>{policy.attributionText}</p>
      <p>{policy.disclaimerText}</p>
      {policy.reviewNumber ? <p>{policy.reviewNumber}</p> : null}
    </div>
  );
}
